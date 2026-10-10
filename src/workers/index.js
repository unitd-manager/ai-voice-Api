import { Worker } from 'bullmq';
import { getRedis, closeRedis } from '../core/database/redis.js';
import { logger } from '../core/logging/logger.js';
import { prisma } from '../core/database/prisma.js';
import { QUEUES, getQueue, closeQueues } from '../platform-services/background-jobs/queues.js';
import { processDocument } from '../ai-platform/document-processing/ingest.service.js';
import { analyzeCall } from '../ai-platform/post-call-intelligence/analysis.service.js';
import { deliver, emitEvent } from '../platform-services/webhooks/outgoing/outgoing.service.js';
import { reprocessPendingInbox, dailyMaintenance } from './maintenance.js';
import { fetchAndStoreRecording } from '../ai-platform/recording/recording.service.js';
import { dispatchIntegrations } from '../saas-platform/integrations/integrations.service.js';

const connection = getRedis();
const mk = (queue, fn, concurrency = 5) => {
  const w = new Worker(queue, async (job) => fn(job), { connection, concurrency });
  w.on('failed', (job, err) => logger.warn({ queue, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
  return w;
};
const workers = [
  mk(QUEUES.ingestion, (j) => processDocument(j.data.documentId, j.id)),
  mk(QUEUES.postCall, async (j) => { const a = await analyzeCall(j.data.callId); const c = await prisma.call.findUnique({ where: { id: j.data.callId }, select: { orgId: true } }); if (c) { const type = a ? 'call.analyzed' : 'call.completed'; await emitEvent(c.orgId, type, { callId: j.data.callId, analysis: a }); await dispatchIntegrations(c.orgId, type, { callId: j.data.callId, analysis: a }); } }),
  mk(QUEUES.outgoingWebhooks, (j) => deliver(j.data.deliveryId), 10),
  mk(QUEUES.recording, (j) => fetchAndStoreRecording(j.data.callId, j.data.url), 3),
  mk(QUEUES.reconcile, async (j) => (j.name === 'daily' ? dailyMaintenance() : reprocessPendingInbox()), 1),
];
// Repeatable sweeps: the DB is the source of truth, the queue just drives re-processing.
await getQueue(QUEUES.reconcile).add('inbox', {}, { repeat: { every: 5 * 60e3 }, jobId: 'inbox-sweep' });
await getQueue(QUEUES.reconcile).add('daily', {}, { repeat: { pattern: '0 3 * * *' }, jobId: 'daily-sweep' });
logger.info({ queues: Object.values(QUEUES) }, 'Workers started');

async function shutdown(sig) { logger.info({ sig }, 'worker shutting down'); await Promise.allSettled(workers.map((w) => w.close())); await closeQueues(); await prisma.$disconnect(); await closeRedis(); process.exit(0); }
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
