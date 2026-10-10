import { createApp } from './app.js';
import { env } from './core/config/env.js';
import { logger } from './core/logging/logger.js';
import { prisma } from './core/database/prisma.js';
import { closeRedis } from './core/database/redis.js';

const app = createApp();
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening'));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
