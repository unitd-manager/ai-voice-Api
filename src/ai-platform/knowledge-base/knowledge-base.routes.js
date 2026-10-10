import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok, created } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { storage } from '../../platform-services/storage/storage.service.js';
import { enqueue, QUEUES } from '../../platform-services/background-jobs/queues.js';
import { validateUpload } from '../document-processing/extract.js';
import { vectorStore } from '../vector-store/qdrant.client.js';
import { retrieve, evaluateRetrieval } from '../rag/rag.service.js';
import { assertWithinCount, getEntitlements } from '../../saas-platform/entitlements/entitlements.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const orgP = z.object({ orgId: z.string().max(40) });
const kbP = orgP.extend({ kbId: z.string().max(40) });
const docP = kbP.extend({ docId: z.string().max(40) });
const ownKb = async (orgId, id) => { const kb = await prisma.knowledgeBase.findFirst({ where: { id, orgId } }); if (!kb) throw AppError.notFound('Knowledge base not found'); return kb; };
const ownDoc = async (orgId, kbId, id) => { const d = await prisma.knowledgeDocument.findFirst({ where: { id, orgId, knowledgeBaseId: kbId } }); if (!d) throw AppError.notFound('Document not found'); return d; };

export const knowledgeBaseRouter = Router({ mergeParams: true });
knowledgeBaseRouter.get('/', validate({ params: orgP }), guard('kb:read'), h(async (req, res) => ok(res, await prisma.knowledgeBase.findMany({ where: { orgId: req.org.id }, orderBy: { createdAt: 'desc' } }))));
knowledgeBaseRouter.post('/', validate({ params: orgP, body: z.object({ name: z.string().min(1).max(100), description: z.string().max(500).optional() }) }), guard('kb:write'), h(async (req, res) => created(res, await prisma.knowledgeBase.create({ data: { orgId: req.org.id, ...req.body } }))));
knowledgeBaseRouter.get('/:kbId/documents', validate({ params: kbP }), guard('kb:read'), h(async (req, res) => { await ownKb(req.org.id, req.params.kbId); ok(res, await prisma.knowledgeDocument.findMany({ where: { orgId: req.org.id, knowledgeBaseId: req.params.kbId }, orderBy: { createdAt: 'desc' } })); }));
knowledgeBaseRouter.post('/:kbId/documents', validate({ params: kbP }), guard('kb:write'), upload.single('file'), h(async (req, res) => {
  await ownKb(req.org.id, req.params.kbId);
  if (!req.file) throw AppError.badRequest('file is required');
  validateUpload(req.file.buffer, req.file.mimetype);
  const ent = await getEntitlements(req.org.id);
  if (!ent.active) throw new AppError(402, 'SUBSCRIPTION_REQUIRED', 'An active subscription is required');
  if (ent.limits.storageBytes !== -1) {
    const used = await prisma.knowledgeDocument.aggregate({ where: { orgId: req.org.id }, _sum: { sizeBytes: true } });
    if ((used._sum.sizeBytes ?? 0) + req.file.size > ent.limits.storageBytes) throw new AppError(403, 'PLAN_LIMIT', 'Storage limit reached');
  }
  const id = randomUUID();
  const storageKey = `orgs/${req.org.id}/kb/${req.params.kbId}/${id}`; // server-generated: user filename never touches paths
  await storage.put(storageKey, req.file.buffer, req.file.mimetype);
  const doc = await prisma.knowledgeDocument.create({ data: { id, orgId: req.org.id, knowledgeBaseId: req.params.kbId, filename: req.file.originalname.replace(/[^\w.\- ]/g, '_').slice(0, 200), mimeType: req.file.mimetype, sizeBytes: req.file.size, storageKey, contentHash: createHash('sha256').update(req.file.buffer).digest('hex') } });
  await enqueue(QUEUES.ingestion, { documentId: doc.id }, { jobId: `ingest-${doc.id}-${Date.now()}` });
  created(res, doc);
}));
knowledgeBaseRouter.post('/:kbId/documents/:docId/reprocess', validate({ params: docP }), guard('kb:write'), h(async (req, res) => {
  const d = await ownDoc(req.org.id, req.params.kbId, req.params.docId);
  await prisma.knowledgeDocument.update({ where: { id: d.id }, data: { status: 'PENDING' } });
  await enqueue(QUEUES.ingestion, { documentId: d.id }, { jobId: `ingest-${d.id}-${Date.now()}` }); ok(res, {});
}));
knowledgeBaseRouter.delete('/:kbId/documents/:docId', validate({ params: docP }), guard('kb:write'), h(async (req, res) => {
  const d = await ownDoc(req.org.id, req.params.kbId, req.params.docId);
  await vectorStore.deleteByDocument(req.org.id, d.id).catch(() => {});
  await storage.delete(d.storageKey).catch(() => {});
  await prisma.knowledgeDocument.delete({ where: { id: d.id } }); ok(res, {});
}));
knowledgeBaseRouter.post('/:kbId/search-test', validate({ params: kbP, body: z.object({ agentId: z.string().max(40), query: z.string().min(1).max(500) }) }), guard('kb:read'), h(async (req, res) => {
  const agent = await prisma.agent.findFirst({ where: { id: req.body.agentId, orgId: req.org.id } });
  if (!agent) throw AppError.notFound('Agent not found');
  ok(res, await retrieve({ orgId: req.org.id, agentId: agent.id, query: req.body.query }));
}));

knowledgeBaseRouter.post('/:kbId/evaluate', validate({ params: kbP, body: z.object({ agentId: z.string().max(40), topK: z.number().int().min(1).max(10).default(4), cases: z.array(z.object({ query: z.string().min(1).max(500), expectedDocumentId: z.string().max(40) })).min(1).max(50) }) }), guard('kb:read'), h(async (req, res) => {
  const agent = await prisma.agent.findFirst({ where: { id: req.body.agentId, orgId: req.org.id } });
  if (!agent) throw AppError.notFound('Agent not found');
  ok(res, await evaluateRetrieval({ orgId: req.org.id, agentId: agent.id, cases: req.body.cases, topK: req.body.topK }));
}));
