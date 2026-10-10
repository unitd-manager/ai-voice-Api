import { randomUUID } from 'node:crypto';
import { prisma } from '../../core/database/prisma.js';
import { storage } from '../../platform-services/storage/storage.service.js';
import { extractText, validateUpload } from './extract.js';
import { chunkText } from './chunker.js';
import { embedTexts } from '../embeddings/embeddings.service.js';
import { vectorStore } from '../vector-store/qdrant.client.js';
import { recordUsage } from '../../saas-platform/usage-metering/usage.service.js';

// Idempotent: a re-run (job retry or manual reprocess) first removes previous chunks and vectors.
export async function processDocument(documentId, jobId = 'manual') {
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!doc) return;
  await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'PROCESSING', error: null } });
  try {
    const buf = await storage.get(doc.storageKey);
    const kind = validateUpload(buf, doc.mimeType);
    const chunks = chunkText(await extractText(buf, kind));
    if (!chunks.length) throw new Error('No extractable text');
    await vectorStore.ensureCollection();
    await vectorStore.deleteByDocument(doc.orgId, doc.id);
    await prisma.documentChunk.deleteMany({ where: { documentId: doc.id } });
    const { vectors, tokens } = await embedTexts(chunks);
    const ids = chunks.map(() => randomUUID());
    await vectorStore.upsert(chunks.map((text, i) => ({ id: ids[i], vector: vectors[i], payload: { orgId: doc.orgId, knowledgeBaseId: doc.knowledgeBaseId, documentId: doc.id, filename: doc.filename, ordinal: i, text } })));
    await prisma.documentChunk.createMany({ data: chunks.map((text, i) => ({ orgId: doc.orgId, documentId: doc.id, ordinal: i, text, pointId: ids[i] })) });
    await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'READY', chunkCount: chunks.length } });
    await recordUsage({ orgId: doc.orgId, metric: 'EMBEDDING_TOKENS', quantity: tokens, idempotencyKey: `embed:${doc.id}:${jobId}` });
  } catch (err) {
    await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'FAILED', error: String(err.message).slice(0, 500) } });
    throw err; // let BullMQ retry with backoff
  }
}
