import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startTelegramBot } from "./telegram-bot";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { setupSecurityMiddleware, apiLimiter, authLimiter, scheduleLimiter, apiVersionHeader, requestIdMiddleware } from "./middleware";
import { isMobileAuth, verifyMobileToken } from "./mobile-auth";
import { productionRuntimePolicy } from "./runtime-policy";
import { BUILD_SOURCE_SHA256 } from "./release/build-identity";
import { registerLiveProductRoutes } from "./production/product-routes";
import { createProductAuthentication } from "./production/product-auth";
import { legacyProductionRouteFence } from "./production/legacy-route-fence";
import { assertIsolatedRuntimeReady, assertLocalRequestHeaders, isIsolatedMode } from "./isolated-guard";
import {safeApiLogPath} from './production/safe-request-log';
import {createCanonicalRuntime} from './production/canonical-runtime';
import {registerProductAddressRoutes} from './production/address-flow';
import {registerProductionToolsRoutes} from './production/product-tools-routes';
import {createRuntimeSourceProof} from './production/runtime-source-proof';
import {createOwnerAuthEpoch} from './production/auth-epoch';
import {registerAccountLinkRoutes} from './production/account-links-http';
import {createAccountOriginGuard} from './production/account-origin';
import {readReleaseCampaignConfiguration,releaseCampaignPublicFields} from './production/release-campaign';

const isolated = isIsolatedMode();
if (isolated) assertIsolatedRuntimeReady();

const app = express();
const httpServer = createServer(app);
let canonicalRuntime:ReturnType<typeof createCanonicalRuntime>|undefined;

if (isolated) {
  app.use((req, res, next) => {
    try {
      assertLocalRequestHeaders({ host: req.headers.host, origin: req.headers.origin,
        "sec-fetch-site": String(req.headers["sec-fetch-site"] || "") }, Number(process.env.PORT || "5417"));
      next();
    } catch {
      res.status(403).json({ error: "LBA_LOCAL_ORIGIN_REQUIRED" });
    }
  });
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

setupSecurityMiddleware(app);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
    limit: '1mb',
  }),
);

app.use(express.urlencoded({ extended: false }));

app.use('/api', apiVersionHeader);
app.use('/api', requestIdMiddleware);
app.use('/api', apiLimiter);
app.use('/api/schedule', scheduleLimiter);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = safeApiLogPath(req.path);
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      log(logLine);
    }
  });

  next();
});

(async () => {
  if (isolated) {
    const { seedIsolatedData } = await import("./isolated-seed");
    await seedIsolatedData();
  }
  const policy=!isolated&&process.env.NODE_ENV==='production'?productionRuntimePolicy():null;
  if(policy?.productProfileMode==='active'&&!BUILD_SOURCE_SHA256)throw Error('CANONICAL_BUILD_IDENTITY_REQUIRED');
  const ownerAuth=policy?.productProfileMode==='active'?createOwnerAuthEpoch({pool:(await import('./db')).pool,verifyMobile:verifyMobileToken,now:()=>Math.floor(Date.now()/1000)}):undefined;
  const onVerifiedLogin:NonNullable<Parameters<typeof setupAuth>[1]>['onVerifiedLogin']=async input=>{await canonicalRuntime?.finishVerifiedLogin?.(input);};
  await setupAuth(app,{onVerifiedLogin,limiter:authLimiter});
  // Passport reads the cookie first; an explicit verified Bearer then takes
  // precedence. No legacy reader may accidentally use the other cookie owner.
  app.use('/api',isMobileAuth);
  if(ownerAuth)app.use(ownerAuth.enforce);
  const authenticate=createProductAuthentication({verifyMobile:verifyMobileToken,authenticateSession:isAuthenticated});
  registerAuthRoutes(app,authenticate);
  if(!isolated&&process.env.NODE_ENV==='production')app.get('/api/version',(_req,res)=>res.json({version:BUILD_SOURCE_SHA256,build:BUILD_SOURCE_SHA256}));
  if (!isolated && process.env.NODE_ENV==='production') app.use(legacyProductionRouteFence());
  await registerRoutes(httpServer, app,{onVerifiedLogin,sessionIsCurrent:ownerAuth?.sessionIsCurrent});
  if (!isolated && process.env.NODE_ENV==='production' && BUILD_SOURCE_SHA256) {
    const policy=productionRuntimePolicy();
    const releaseCampaign=readReleaseCampaignConfiguration(process.env.LBA_RELEASE_NOTICE_CONFIG,BUILD_SOURCE_SHA256);
    if(policy.productProfileMode==='active'){
      const {pool}=await import('./db');
      canonicalRuntime=createCanonicalRuntime({pool,policy,token:process.env.TELEGRAM_BOT_TOKEN!,origin:'https://power-ukraine.net',fetch,
        ...(releaseCampaign?{releaseCampaign}:{}),
        verifySource:createRuntimeSourceProof({expectedControlEpoch:policy.canonicalControlEpoch!}),authorizePrincipal:ownerAuth!.authorizePrincipal,
        accountConfiguration:{bindingKey:process.env.SESSION_SECRET!,...(policy.accountLinksEnabled?{browserWidget:{botUsername:'PowerUkraineBot',configurationVerified:true as const}}:{})}});
      await canonicalRuntime.prepare();
      registerLiveProductRoutes(app,{releaseId:BUILD_SOURCE_SHA256,mode:'active',authenticate,store:canonicalRuntime.store,toolsEnabled:true});
      registerProductAddressRoutes(app,{authenticate,flow:canonicalRuntime.flow});
      registerProductionToolsRoutes(app,{authenticate,enabled:true,tools:canonicalRuntime.tools});
      registerAccountLinkRoutes(app,{enabled:true,telegramLinkingEnabled:policy.accountLinksEnabled,widgetLinkingEnabled:policy.accountLinksEnabled,miniAppProofEnabled:false,service:canonicalRuntime.accounts!,authenticate,
        principal:req=>ownerAuth!.accountPrincipal(req),sameOrigin:createAccountOriginGuard('https://power-ukraine.net'),limiter:authLimiter,
        recoveryAuthenticate:(req,res,next)=>{void ownerAuth!.accountPrincipal(req,true).then(()=>next(),()=>res.sendStatus(401));},recoveryPrincipal:req=>ownerAuth!.accountPrincipal(req,true)});
    }else registerLiveProductRoutes(app,{
      releaseId:BUILD_SOURCE_SHA256,mode:policy.productProfileMode,authenticate,
      read:async principal=>{
        const [{pool},{readOwnedLegacyProfile}]=await Promise.all([import('./db'),import('./production/legacy-identity-links')]);
        return readOwnedLegacyProfile(pool,principal);
      },
    });
    app.get('/api/health/release',(_req,res)=>{
      res.setHeader('Cache-Control','no-store');
      res.json({releaseId:BUILD_SOURCE_SHA256,mode:'production',profileMode:policy.productProfileMode,
        ...releaseCampaignPublicFields(releaseCampaign,BUILD_SOURCE_SHA256!,new Date().toISOString()),
        status:'process_serving',productAccepted:false,...(canonicalRuntime?{canonical:canonicalRuntime.health()}:{})});
    });
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const suppliedStatus = err.status || err.statusCode;
    const status = Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus <= 599 ? suppliedStatus : 500;
    const production = !isolated && process.env.NODE_ENV === 'production';
    const message = production ? 'Не вдалося виконати запит. Спробуйте пізніше.' : err.message || 'Internal Server Error';

    if (production) console.error('[API] Request failed', { status });
    else console.error('Internal Server Error:', err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (isolated || process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: isolated ? "127.0.0.1" : "0.0.0.0",
      reusePort: !isolated,
    },
    () => {
      log(`serving on port ${port}`);
      canonicalRuntime?.start();
      if (!isolated && process.env.NODE_ENV!=='production') startTelegramBot().catch(() => console.error('[TG Bot] Failed to start'));
    },
  );
})().catch(async () => {
  console.error(isolated ? "LBA_ISOLATED_START_FAILED: check disposable schema, static build and local configuration" : "Application startup failed");
  if (isolated) {
    const { pool } = await import("./db");
    await pool.end();
  }
  process.exitCode = 1;
});

// Stop taking requests before draining explicit workers. The old bot is never
// started in production; deployment overlap still requires platform cutover proof.
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{
  httpServer.close(()=>{void (async()=>{await canonicalRuntime?.stop();const {pool}=await import('./db');await pool.end();})().catch(()=>{process.exitCode=1;});});
});
