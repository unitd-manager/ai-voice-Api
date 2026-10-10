import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './core/config/env.js';
import { logger } from './core/logging/logger.js';
import { requestId } from './core/middleware/request-id.js';
import { errorHandler, notFoundHandler } from './core/middleware/error-handler.js';
import { fail } from './core/response/respond.js';
import { healthRouter } from './platform-services/monitoring/health.routes.js';
import { apiV1Router } from './routes/index.js';
import { stripeWebhookHandler } from './platform-services/webhooks/billing-provider/stripe.webhook.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(helmet());
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false, credentials: true }));

  app.use(healthRouter);

  // NOTE: provider webhooks (Phase 3/6) must be mounted BEFORE this JSON parser with express.raw()
  // so signatures can be verified against the exact bytes.
  app.post('/api/v1/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhookHandler);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => fail(res, 429, 'RATE_LIMITED', 'Too many requests, please retry later'),
  }), apiV1Router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
