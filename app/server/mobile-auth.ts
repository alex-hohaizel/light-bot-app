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
}

export function generateMobileToken(userId: string, firstName?: string): string {
  return jwt.sign(
    { sub: userId, firstName, type: 'mobile' },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY, issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE }
  );
}

export function verifyMobileToken(token: string): MobileTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      clockTolerance: 30,
    }) as MobileTokenPayload;
    if (decoded.type !== 'mobile') return null;
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
    claims: {
      sub: payload.sub,
      first_name: payload.firstName,
    },
  };
  (req as any).isMobileClient = true;
  next();
}

export function isAuthenticatedMobileOrSession(req: Request, res: Response, next: NextFunction) {
  if ((req as any).user) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyMobileToken(token);
    if (payload) {
      (req as any).user = {
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

  return res.status(401).json({ error: 'Authentication required' });
}
