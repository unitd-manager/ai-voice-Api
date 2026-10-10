import { env } from '../../core/config/env.js';
import { prisma } from '../../core/database/prisma.js';
import { getRedis } from '../../core/database/redis.js';
import { getQueue, QUEUES } from '../../platform-services/background-jobs/queues.js';

const probe = async (configured, fn) => {
  if (!configured) return { status: 'not_configured' };
  const t = Date.now();
  try { await fn(AbortSignal.timeout(3000)); return { status: 'ok', ms: Date.now() - t }; } catch (e) { return { status: 'error', ms: Date.now() - t, error: String(e.message).slice(0, 80) }; }
};
const get = (url, headers, signal) => fetch(url, { headers, signal }).then((r) => { if (!r.ok) throw new Error(`http_${r.status}`); });

// Provider + queue health for operators. Never returns secrets or raw provider errors.
export async function providerHealth() {
  const [database, redis, vapi, qdrant, llm, embeddings] = await Promise.all([
    probe(true, () => prisma.$queryRaw`SELECT 1`),
    probe(true, () => getRedis().ping()),
    probe(!!env.VAPI_API_KEY, (s) => get('https://api.vapi.ai/assistant?limit=1', { Authorization: `Bearer ${env.VAPI_API_KEY}` }, s)),
    probe(!!env.QDRANT_URL, (s) => get(`${env.QDRANT_URL.replace(/\/$/, '')}/healthz`, env.QDRANT_API_KEY ? { 'api-key': env.QDRANT_API_KEY } : {}, s)),
    probe(!!(env.LLM_BASE_URL && env.LLM_API_KEY), (s) => get(`${env.LLM_BASE_URL.replace(/\/$/, '')}/models`, { Authorization: `Bearer ${env.LLM_API_KEY}` }, s)),
    probe(!!(env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY), (s) => get(`${env.EMBEDDING_BASE_URL.replace(/\/$/, '')}/models`, { Authorization: `Bearer ${env.EMBEDDING_API_KEY}` }, s)),
  ]);
  const queues = {};
  for (const name of Object.values(QUEUES)) { try { queues[name] = await getQueue(name).getJobCounts('waiting', 'active', 'failed', 'delayed'); } catch { queues[name] = 'unavailable'; } }
  const unprocessedWebhooks = await prisma.webhookEvent.count({ where: { processedAt: null } }).catch(() => null);
  return { providers: { database, redis, vapi, qdrant, llm, embeddings, stripe: { status: env.STRIPE_SECRET_KEY ? 'configured' : 'not_configured' } }, queues, unprocessedWebhooks };
}
