import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import { randomUUID } from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';

export function setupSecurityMiddleware(app: Express) {
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
  }));

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowedPatterns = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/.*\.replit\.(app|dev|co)$/,
        /^capacitor:\/\//,
        /^ionic:\/\//,
        /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
        /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
      ];
      const isAllowed = allowedPatterns.some(p => p.test(origin));
      callback(null, isAllowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Version', 'X-Device-Id'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-API-Version'],
  }));

  app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req) => {
      if (req.path === '/api/user/settings-stream') return false;
      return true;
    },
  }));
}

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: 'Too many requests',
      message: 'Забагато запитів. Спробуйте через хвилину.',
      retryAfter: 60,
    });
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: 'Too many auth attempts',
      message: 'Забагато спроб авторизації. Спробуйте через 15 хвилин.',
      retryAfter: 900,
    });
  },
});

export const scheduleLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

export function apiVersionHeader(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-API-Version', '1.0');
  next();
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = req.headers['x-request-id'] as string || randomUUID();
  res.setHeader('X-Request-Id', requestId);
  next();
}
