import { prisma } from '../../core/database/prisma.js';
import { embedTexts } from '../embeddings/embeddings.service.js';
import { vectorStore } from '../vector-store/qdrant.client.js';
import { recordUsage } from '../../saas-platform/usage-metering/usage.service.js';

export const DEFAULT_THRESHOLD = 0.35;
export const NO_ANSWER = 'NO_RELEVANT_KNOWLEDGE';

// Tenant- and agent-scoped retrieval. Returns citations and an explicit no-answer signal.
export async function retrieve({ orgId, agentId, query, topK = 4, threshold = DEFAULT_THRESHOLD, usageKey, knowledgeBaseId }) {
  const links = await prisma.agentKnowledgeBase.findMany({ where: { agentId, ...(knowledgeBaseId ? { knowledgeBaseId } : {}), kb: { orgId } }, select: { knowledgeBaseId: true } }); // join through org: foreign ids are dropped
  const knowledgeBaseIds = links.map((l) => l.knowledgeBaseId);
  if (!knowledgeBaseIds.length) return { answerable: false, reason: 'NO_KNOWLEDGE_BASE', chunks: [] };
  const { vectors, tokens } = await embedTexts([query]);
  if (usageKey) await recordUsage({ orgId, metric: 'EMBEDDING_TOKENS', quantity: tokens, idempotencyKey: usageKey });
  const hits = await vectorStore.search(vectors[0], { orgId, knowledgeBaseIds, limit: topK, threshold });
  const chunks = hits.filter((h) => h.score >= threshold).map((h) => ({ score: h.score, text: h.payload.text, citation: { documentId: h.payload.documentId, filename: h.payload.filename, ordinal: h.payload.ordinal } }));
  return chunks.length ? { answerable: true, chunks } : { answerable: false, reason: NO_ANSWER, chunks: [] };
}

export function buildContext(result) {
  if (!result.answerable) return 'No relevant information was found in the knowledge base. Say you do not know instead of guessing.';
  return result.chunks.map((c, i) => `[${i + 1}] (${c.citation.filename}) ${c.text}`).join('\n\n');
}

// Retrieval evaluation: fraction of labelled queries whose expected document appears in the top-k.
export async function evaluateRetrieval({ orgId, agentId, cases, topK = 4, knowledgeBaseId }) {
  let hit = 0; const details = [];
  for (const c of cases) {
    const r = await retrieve({ orgId, agentId, query: c.query, topK, knowledgeBaseId });
    const ok = r.chunks.some((x) => x.citation.documentId === c.expectedDocumentId);
    if (ok) hit++; details.push({ query: c.query, ok });
  }
  return { recallAtK: cases.length ? hit / cases.length : 0, total: cases.length, details };
}
