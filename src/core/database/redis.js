import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../logging/logger.js';

let connection;
// BullMQ requires maxRetriesPerRequest: null.
export function getRedis() {
  if (!connection) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    connection.on('error', (err) => logger.warn({ err: err.message }, 'Redis error'));
  }
  return connection;
}
export async function closeRedis() {
  if (connection) { await connection.quit().catch(() => {}); connection = undefined; }
}
