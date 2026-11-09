import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const generated = randomBytes(64).toString('hex');
  console.warn('[mobile-auth] WARNING: JWT_SECRET not set. Using generated secret. Tokens will not survive restarts. Set JWT_SECRET env var for production.');
  return generated;
})();
const TOKEN_EXPIRY = '30d';
const TOKEN_ISSUER = 'svitlo-ukraine';
const TOKEN_AUDIENCE = 'svitlo-mobile';

export interface MobileTokenPayload {
  sub: string;
  firstName?: string;
  iat: number;
  exp: number;
  type: 'mobile';
  iss?: string;
  aud?: string;
  authEpoch?:number;
}

export function generateMobileToken(userId: string, firstName?: string,authEpoch=0): string {
  if(!Number.isSafeInteger(authEpoch)||authEpoch<0)throw Error('INVALID_AUTH_EPOCH');
  return jwt.sign(
    { sub: userId, firstName, type: 'mobile',authEpoch },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY, issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE }
  );
}

export function verifyMobileToken(token: string): MobileTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      clockTolerance: 30,
    }) as MobileTokenPayload;
    if (!decoded || typeof decoded !== 'object' || decoded.type !== 'mobile' || typeof decoded.sub !== 'string' ||
      !decoded.sub.trim() || decoded.sub.length > 255 || /[\u0000-\u001f\u007f]/.test(decoded.sub)||decoded.authEpoch!==undefined&&(!Number.isSafeInteger(decoded.authEpoch)||decoded.authEpoch<0)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

export function isMobileAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.slice(7);
  const payload = verifyMobileToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  (req as any).user = {
    authEpoch:payload.authEpoch??0,
    claims: {
      sub: payload.sub,
      first_name: payload.firstName,
    },
  };
  (req as any).isMobileClient = true;
  next();
}

export function isAuthenticatedMobileOrSession(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader !== undefined) {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Invalid token' });
    const token = authHeader.slice(7);
    const payload = verifyMobileToken(token);
    if (payload) {
      (req as any).user = {
        authEpoch:payload.authEpoch??0,
        claims: {
          sub: payload.sub,
          first_name: payload.firstName,
        },
      };
      (req as any).isMobileClient = true;
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user=(req as any).user;
  if (typeof req.isAuthenticated === 'function' && req.isAuthenticated() === true &&
    Number.isSafeInteger(user?.expires_at) && user.expires_at > Math.floor(Date.now()/1000) &&
    typeof user?.claims?.sub === 'string' && user.claims.sub.trim() && user.claims.sub.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(user.claims.sub)) return next();

  return res.status(401).json({ error: 'Authentication required' });
}
