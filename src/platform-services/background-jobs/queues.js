import { Queue } from 'bullmq';
import { getRedis } from '../../core/database/redis.js';
import { logger } from '../../core/logging/logger.js';

export const QUEUES = { postCall: 'post-call', ingestion: 'document-ingestion', outgoingWebhooks: 'outgoing-webhooks', notifications: 'notifications', reconcile: 'billing-reconcile', inbox: 'webhook-inbox', recording: 'recording-download' };
export const DEFAULT_JOB_OPTS = { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } };

const queues = new Map();
export const getQueue = (name) => { if (!queues.has(name)) queues.set(name, new Queue(name, { connection: getRedis() })); return queues.get(name); };

// Queues are only a delivery mechanism: the durable record (DB row) is written FIRST by callers, and a
// reconciliation sweep re-enqueues anything unprocessed. Enqueue failure is therefore non-fatal.
export async function enqueue(name, data, opts = {}) {
  try { return await getQueue(name).add(name, data, { ...DEFAULT_JOB_OPTS, ...opts }); }
  catch (err) { logger.error({ err: err.message, queue: name }, 'enqueue failed (will be picked up by reconciliation)'); return null; }
}
export async function closeQueues() { await Promise.allSettled([...queues.values()].map((q) => q.close())); queues.clear(); }
