import { env } from '../../core/config/env.js';
import { AppError } from '../../core/errors/app-error.js';

const COLLECTION = 'kb_chunks';
async function q(method, path, body, fetchImpl = fetch) {
  if (!env.QDRANT_URL) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Vector store is not configured');
  const res = await fetchImpl(`${env.QDRANT_URL.replace(/\/$/, '')}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(env.QDRANT_API_KEY ? { 'api-key': env.QDRANT_API_KEY } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!res.ok && res.status !== 404) throw new AppError(502, 'PROVIDER_ERROR', `Vector store error (${res.status})`);
  return res.status === 404 ? null : res.json();
}

export const vectorStore = {
  async ensureCollection() {
    if (await q('GET', `/collections/${COLLECTION}`)) return;
    await q('PUT', `/collections/${COLLECTION}`, { vectors: { size: env.EMBEDDING_DIM, distance: 'Cosine' } });
    for (const f of ['orgId', 'knowledgeBaseId', 'documentId']) await q('PUT', `/collections/${COLLECTION}/index`, { field_name: f, field_schema: 'keyword' });
  },
  upsert: (points) => q('PUT', `/collections/${COLLECTION}/points?wait=true`, { points }),
  // orgId is ALWAYS part of the filter, so a bug in KB selection can never cross tenants.
  search: (vector, { orgId, knowledgeBaseIds, limit = 5, threshold }) => q('POST', `/collections/${COLLECTION}/points/search`, {
    vector, limit, with_payload: true, ...(threshold != null ? { score_threshold: threshold } : {}),
    filter: { must: [{ key: 'orgId', match: { value: orgId } }, { key: 'knowledgeBaseId', match: { any: knowledgeBaseIds } }] },
  }).then((r) => r?.result ?? []),
  deleteByDocument: (orgId, documentId) => q('POST', `/collections/${COLLECTION}/points/delete?wait=true`, { filter: { must: [{ key: 'orgId', match: { value: orgId } }, { key: 'documentId', match: { value: documentId } }] } }),
};
