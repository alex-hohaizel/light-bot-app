import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";

import passport from "passport";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { pool } from "../../db";
import { createReplitIdentityResolver } from "../../production/replit-identity";
import { prepareReplitSession } from "../../production/replit-session";
import { assertIsolatedRuntimeReady, isIsolatedMode, SYNTHETIC_USER_ID } from "../../isolated-guard";
import type {VerifiedSessionHook} from '../../production/verified-session';
import {isDetachedAccountIdentity} from '../../production/account-links';

const getOidcConfig = memoize(
  async () => {
    return await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID!
    );
  },
  { maxAge: 3600 * 1000 }
);

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite:'lax',
      maxAge: sessionTtl,
    },
  });
}

const replitIdentity = createReplitIdentityResolver(pool,{isDetached:(client,subject)=>
  process.env.NODE_ENV==='production'&&process.env.LBA_PRODUCT_PROFILE_MODE==='active'?isDetachedAccountIdentity(client,'replit',subject):Promise.resolve(false)});

export async function setupAuth(app: Express,hooks:{onVerifiedLogin?:VerifiedSessionHook;limiter?:RequestHandler}={}) {
  if (isIsolatedMode()) {
    assertIsolatedRuntimeReady();
    // Explicit local-only identity; application data still uses the real pg/Drizzle path.
    app.use((req: any, _res, next) => {
      req.user = { claims: { sub: SYNTHETIC_USER_ID, first_name: "Тестовий" }, expires_at: 4102444800 };
      req.isAuthenticated = () => true;
      req.session = { destroy: (callback: () => void) => callback() };
      req.login = (_user: unknown, callback: () => void) => callback();
      req.logout = (callback: () => void) => callback();
      next();
    });
    app.get("/api/login", (_req, res) => res.redirect("/"));
    app.get("/api/logout", (_req, res) => res.redirect("/"));
    return;
  }
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  const config = await getOidcConfig();

  const verify: VerifyFunction = async (tokens, verified: passport.AuthenticateCallback) => {
    try {
      const claims = tokens.claims();
      if (!claims) throw Error('REPLIT_AUTH_UNCONFIRMED');
      const signed = structuredClone(claims);
      const tokenSnapshot = { access_token: tokens.access_token, refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in, claims: () => signed };
      const owner = await replitIdentity.login(signed);
      const user = prepareReplitSession(null, tokenSnapshot, owner, Math.floor(Date.now() / 1000));
      verified(null, user);
    } catch { verified(new Error('REPLIT_AUTH_UNCONFIRMED')); }
  };

  // Keep track of registered strategies
  const registeredStrategies = new Set<string>();

  // Helper function to ensure strategy exists for a domain
  const ensureStrategy = (domain: string) => {
    const strategyName = `replitauth:${domain}`;
    if (!registeredStrategies.has(strategyName)) {
      const strategy = new Strategy(
        {
          name: strategyName,
          config,
          scope: "openid email profile offline_access",
          callbackURL: `https://${domain}/api/callback`,
        },
        verify
      );
      passport.use(strategy);
      registeredStrategies.add(strategyName);
    }
  };

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  const limit=hooks.limiter??((_req,_res,next)=>next());
  app.get("/api/login",limit, (req: any, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: "login consent",
      scope: ["openid", "email", "profile", "offline_access"],
    })(req, res, next);
  });

  // Account linking requires a separate proof/preview flow; ordinary OAuth login never merges profiles.
  app.get("/api/auth/link-replit", (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ error: 'Під’єднання акаунтів ще проходить перевірку. Збережені профілі не змінено.' });
  });

  app.get("/api/callback",limit, (req: any, res, next) => {
    ensureStrategy(req.hostname);

    if (req.session?.linkingUserId) {
      delete req.session.linkingUserId;
      return res.status(409).json({ error: 'Для під’єднання потрібна нова перевірка. Збережені профілі не змінено.' });
    }

    passport.authenticate(`replitauth:${req.hostname}`, async (err: any, user: any) => {
      if (err || !user) return res.redirect("/api/login");

      const verifiedAt=Math.floor(Date.now()/1000);
      req.login(user, async (loginErr: any) => {
        if (loginErr) {
          return res.redirect("/api/login");
        }
        try{await hooks.onVerifiedLogin?.({req,provider:'replit',providerId:user.providerIdentity.subject,verifiedAt});return res.redirect('/');}
        catch{const session=req.session;req.user=undefined;res.clearCookie('connect.sid',{path:'/',httpOnly:true,secure:true});
          try{if(session)await new Promise<void>((resolve,reject)=>session.destroy((error:unknown)=>error?reject(Error('AUTH_SESSION_CLEANUP_UNCONFIRMED')):resolve()));}catch{}finally{req.session=null;}
          return res.status(401).send('Не вдалося підтвердити вхід. Увійдіть ще раз.');}
      });
    })(req, res, next);
  });

  app.get("/api/logout", (req, res) => {
    req.logout(() => {
      res.redirect(
        client.buildEndSessionUrl(config, {
          client_id: process.env.REPL_ID!,
          post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
        }).href
      );
    });
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  const user = req.user as any;

  if (!req.isAuthenticated() || !Number.isSafeInteger(user?.expires_at) || user.expires_at <= 0) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now < user.expires_at) {
    return next();
  }

  const refreshToken = user.refresh_token;
  if (!refreshToken) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    const claims = tokenResponse.claims();
    const signed = claims ? structuredClone(claims) : undefined;
    const subject = signed?.sub ?? user.providerIdentity?.subject;
    if (typeof subject !== 'string') throw Error('REPLIT_REFRESH_IDENTITY_UNCONFIRMED');
    const owner = await replitIdentity.existing(subject);
    if (owner !== user.claims?.sub) throw Error('REPLIT_REFRESH_IDENTITY_CHANGED');
    const refreshed = prepareReplitSession(user, { access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token, expires_in: tokenResponse.expires_in, claims: () => signed }, owner, now);
    Object.assign(user, refreshed);
    const sessionData = req.session as (typeof req.session & {passport?:{user?:unknown}}) | undefined;
    if (!sessionData?.passport || typeof sessionData.save !== 'function') throw Error('REPLIT_SESSION_UNAVAILABLE');
    sessionData.passport.user = user;
    await new Promise<void>((resolve, reject) => sessionData.save(error => error ? reject(Error('REPLIT_SESSION_SAVE_UNCONFIRMED')) : resolve()));
    return next();
  } catch (error) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
};
