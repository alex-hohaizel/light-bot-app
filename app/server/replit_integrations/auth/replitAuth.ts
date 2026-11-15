import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";

import passport from "passport";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { authStorage } from "./storage";
import { addLinkedAccount, getLinkedAccountByProvider, migrateUserSettings } from "../../storage";
import { assertIsolatedRuntimeReady, isIsolatedMode, SYNTHETIC_USER_ID } from "../../isolated-guard";

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
      maxAge: sessionTtl,
    },
  });
}

function updateUserSession(
  user: any,
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = user.claims?.exp;
}

async function upsertUser(claims: any) {
  const userId = claims["sub"];
  await authStorage.upsertUser({
    id: userId,
    email: claims["email"],
    firstName: claims["first_name"],
    lastName: claims["last_name"],
    profileImageUrl: claims["profile_image_url"],
  });

  const existing = await getLinkedAccountByProvider('replit', userId).catch(() => null);
  if (!existing) {
    const displayName = claims["email"] || claims["first_name"] || userId;
    await addLinkedAccount(userId, 'replit', userId, `Replit: ${displayName}`).catch((e: any) =>
      console.error('[Auth] Failed to create linked account:', e.message));
  }
}

export async function setupAuth(app: Express) {
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

  const verify: VerifyFunction = async (
    tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
    verified: passport.AuthenticateCallback
  ) => {
    const claims = tokens.claims()!;
    const replitId = claims["sub"] as string;

    const linkedAccount = await getLinkedAccountByProvider('replit', replitId).catch(() => null);

    const user: any = {};
    updateUserSession(user, tokens);

    if (linkedAccount && linkedAccount.userId !== replitId) {
      user.claims = { ...(user.claims || {}), sub: linkedAccount.userId };
      await migrateUserSettings(replitId, linkedAccount.userId);
      await authStorage.upsertUser({
        id: replitId,
        email: (claims["email"] as string) || null,
        firstName: (claims["first_name"] as string) || null,
        lastName: (claims["last_name"] as string) || null,
        profileImageUrl: (claims["profile_image_url"] as string) || null,
      });
    } else {
      await upsertUser(claims);
    }

    verified(null, user);
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

  app.get("/api/login", (req: any, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: "login consent",
      scope: ["openid", "email", "profile", "offline_access"],
    })(req, res, next);
  });

  app.get("/api/auth/link-replit", (req: any, res, next) => {
    if (req.isAuthenticated() && req.user?.claims?.sub) {
      req.session.linkingUserId = req.user.claims.sub;
    }
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: "login consent",
      scope: ["openid", "email", "profile", "offline_access"],
    })(req, res, next);
  });

  app.get("/api/callback", (req: any, res, next) => {
    ensureStrategy(req.hostname);

    const linkingUserId = req.session?.linkingUserId;

    passport.authenticate(`replitauth:${req.hostname}`, async (err: any, user: any) => {
      if (err || !user) {
        return res.redirect("/api/login");
      }

      if (linkingUserId && user.claims?.sub) {
        try {
          delete req.session.linkingUserId;
          const replitId = user.claims.sub;
          const displayName = user.claims.email || user.claims.first_name || replitId;

          const existingLink = await getLinkedAccountByProvider('replit', replitId).catch(() => null);
          if (existingLink && existingLink.userId === linkingUserId) {
            console.log(`[Auth] Account replit:${replitId} already linked to user ${linkingUserId}, skipping`);
            user.claims = { ...(user.claims || {}), sub: linkingUserId };
            req.login(user, () => res.redirect("/settings"));
            return;
          }

          if (replitId !== linkingUserId) {
            await migrateUserSettings(replitId, linkingUserId);
          }

          await addLinkedAccount(linkingUserId, 'replit', replitId, `Replit: ${displayName}`);
          await authStorage.upsertUser({
            id: replitId,
            email: user.claims.email || null,
            firstName: user.claims.first_name || null,
            lastName: user.claims.last_name || null,
            profileImageUrl: user.claims.profile_image_url || null,
          });
          console.log(`[Auth] Linked Replit ${replitId} to existing user ${linkingUserId}`);

          user.claims = { ...(user.claims || {}), sub: linkingUserId };
          req.login(user, () => res.redirect("/settings"));
          return;
        } catch (e: any) {
          console.error('[Auth] Linking error:', e.message);
        }
      }

      req.login(user, (loginErr: any) => {
        if (loginErr) {
          return res.redirect("/api/login");
        }
        return res.redirect("/");
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

  if (!req.isAuthenticated() || !user.expires_at) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) {
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
    updateUserSession(user, tokenResponse);
    return next();
  } catch (error) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
};
