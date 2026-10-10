import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
      '*.password', '*.passwordHash', '*.token', '*.refreshToken', '*.apiKey', '*.secret',
    ],
    censor: '[REDACTED]',
  },
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
