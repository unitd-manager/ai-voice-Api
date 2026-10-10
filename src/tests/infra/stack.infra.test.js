import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import JSZip from 'jszip';
import { Queue, Worker } from 'bullmq';
import { SMTPServer } from 'smtp-server';
import { realPrisma as prisma } from '../db/db-client.js';
import { resetDb, makeOrg, makeUser } from '../db/helpers.js';

const { createApp } = await import('../../app.js');
const { getRedis, closeRedis } = await import('../../core/database/redis.js');
const { signAccessToken } = await import('../../core/security/tokens.js');
const { idempotent } = await import('../../core/middleware/idempotency.js');
const { clearMeterCache, flushApiCounts } = await import('../../saas-platform/usage-metering/api-meter.js');
const { recordGauge, getPeriodUsage } = await import('../../saas-platform/usage-metering/usage.service.js');
const { storage } = await import('../../platform-services/storage/storage.service.js');
const { vectorStore } = await import('../../ai-platform/vector-store/qdrant.client.js');
const { extractText } = await import('../../ai-platform/document-processing/extract.js');
const { enqueue, QUEUES, closeQueues } = await import('../../platform-services/background-jobs/queues.js');
const { chat } = await import('../../ai-platform/llm-orchestration/llm.client.js');
const { dailyMaintenance } = await import('../../workers/maintenance.js');
const { embed } = await import('./global-setup.js');

const app = createApp();
const redis = getRedis();
const bearer = (uid) => ({ Authorization: `Bearer ${signAccessToken(uid)}` });
const waitFor = async (fn, ms = 20000, step = 150) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, step)); } };
const control = (body) => fetch('http://127.0.0.1:18089/control', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const qdrantCount = (filter) => fetch(`${process.env.QDRANT_URL}/collections/kb_chunks/points/count`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter, exact: true }) }).then((r) => r.json()).then((j) => j.result.count);

let workers; const mails = []; let smtp;
beforeAll(async () => {
  await resetDb(); await redis.flushdb();
  smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS', 'AUTH'], onData(stream, _s, cb) { let raw = ''; stream.on('data', (c) => (raw += c)); stream.on('end', () => { mails.push(raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))); cb(); }); } });
  await new Promise((r) => smtp.listen(2525, '127.0.0.1', r));
  workers = await import('../../workers/index.js'); // starts the REAL BullMQ workers in-process
});
afterAll(async () => { await workers?.stopWorkers(); await closeQueues(); await new Promise((r) => smtp.close(r)); await closeRedis(); });

function makeDocx(text) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
function makePdf(text) { // minimal valid single-page PDF with computed xref offsets
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`; objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length; pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

describe('real Redis: idempotency + API metering', () => {
  it('5 parallel requests with one Idempotency-Key run the handler exactly once (SET NX)', async () => {
    let runs = 0; const a = express(); a.use(express.json()); a.use((req, _r, n) => { req.org = { id: 'infra' }; n(); });
    a.post('/x', idempotent, async (_q, res) => { runs++; await new Promise((r) => setTimeout(r, 150)); res.status(201).json({ ok: true }); });
    const rs = await Promise.all(Array.from({ length: 5 }, () => request(a).post('/x').set('Idempotency-Key', 'infra-key-0001').send({ v: 1 })));
    expect(runs).toBe(1); expect(rs.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1); expect(rs.every((r) => [201, 409].includes(r.status))).toBe(true);
    const replay = await request(a).post('/x').set('Idempotency-Key', 'infra-key-0001').send({ v: 1 }); expect(replay.headers['idempotent-replay']).toBe('true'); expect(runs).toBe(1);
  });
  it('API quota counts exactly under concurrency, blocks past the limit, and flushes to the durable usage table', async () => {
    const plan = await prisma.plan.create({ data: { code: 'tiny-api', name: 't', entitlements: { apiRequestsPerMonth: 12, concurrentCalls: 1, callMinutes: 1 } } });
    const org = await prisma.organization.create({ data: { name: 'q', slug: 'q-api' } });
    await prisma.subscription.create({ data: { orgId: org.id, planId: plan.id, status: 'ACTIVE', interval: 'MONTH', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 864e6) } });
    const u = await makeUser(org.id, 'VIEWER'); clearMeterCache();
    const rs = await Promise.all(Array.from({ length: 15 }, () => request(app).get(`/api/v1/orgs/${org.id}/agents`).set(bearer(u.id))));
    expect(rs.filter((r) => r.status === 200).length).toBe(12); expect(rs.filter((r) => r.status === 429).length).toBe(3);
    expect(await redis.get(`api:${org.id}:${new Date().toISOString().slice(0, 7)}`)).toBe('15');
    expect(await flushApiCounts(recordGauge)).toBeGreaterThanOrEqual(1); expect(await getPeriodUsage(org.id, 'API_REQUESTS')).toBe(15);
  });
});

describe('real BullMQ semantics', () => {
  it('retries with backoff until success, and a duplicate jobId is processed once', async () => {
    const q = new Queue('infra-retry', { connection: redis }); let attempts = 0; let done = 0;
    const w = new Worker('infra-retry', async () => { attempts++; if (attempts < 3) throw new Error('transient'); done++; }, { connection: redis });
    await q.add('j', {}, { attempts: 4, backoff: { type: 'fixed', delay: 50 }, jobId: 'same' }); await q.add('j', {}, { attempts: 4, jobId: 'same' });
    await waitFor(() => done === 1); await new Promise((r) => setTimeout(r, 300)); expect(attempts).toBe(3); expect(done).toBe(1);
    await w.close(); await q.obliterate({ force: true }); await q.close();
  });
  it('daily maintenance runs against real DB + Redis without error (Stripe reconciliation with nothing to reconcile)', async () => {
    const r = await dailyMaintenance(); expect(r).toMatchObject({ expiredReservations: expect.any(Number), storageOrgs: expect.any(Number), apiCounts: expect.any(Number) }); expect(r.billing).toBeTruthy();
  });
});

describe('real S3 API (s3rver) via the AWS SDK driver', () => {
  it('uses the S3 driver; binary round-trip; delete; missing key errors; traversal keys are rejected', async () => {
    expect(storage.driver).toBe('s3');
    const bin = Buffer.from([0, 255, 1, 128, 7]); await storage.put('orgs/o/x/file.bin', bin, 'application/octet-stream');
    expect((await storage.get('orgs/o/x/file.bin')).equals(bin)).toBe(true);
    await storage.delete('orgs/o/x/file.bin'); await expect(storage.get('orgs/o/x/file.bin')).rejects.toBeTruthy();
    await expect(storage.put('../escape', bin)).rejects.toThrow(/Bad storage key/);
  });
});

describe('real SMTP (smtp-server) via nodemailer', () => {
  it('registration and password-reset emails are really delivered and their tokens work', async () => {
    const r = await request(app).post('/api/v1/auth/register').send({ email: 'smtp-user@x.co', password: 'correct-horse-battery' }); expect(r.status).toBe(201);
    const mail = await waitFor(() => mails.find((m) => /Verify your email/.test(m)));
    expect(mail).toMatch(/To: smtp-user@x\.co/); const token = /token=([\w-]+)/.exec(mail)[1];
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'smtp-user@x.co' });
    const reset = await waitFor(() => mails.find((m) => /Reset your password/.test(m))); const rt = /token=([\w-]+)/.exec(reset)[1];
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: rt, password: 'a-new-password-123' })).status).toBe(200);
  });
});

describe('real Qdrant: tenant filter, thresholds, deletion scope', () => {
  it('search is org-scoped; delete by document is org-scoped; ensureCollection is idempotent', async () => {
    await vectorStore.ensureCollection(); await vectorStore.ensureCollection();
    const { randomUUID } = await import('node:crypto'); const docId = `shared-${randomUUID()}`;
    const pt = (org, text) => ({ id: randomUUID(), vector: embed(text), payload: { orgId: org, knowledgeBaseId: 'kb1', documentId: docId, text } });
    await vectorStore.upsert([pt('orgA', 'refund window thirty days'), pt('orgB', 'refund window ninety days')]);
    const q = embed('how long is the refund window');
    const a = await vectorStore.search(q, { orgId: 'orgA', knowledgeBaseIds: ['kb1'], limit: 5 }); expect(a.map((x) => x.payload.orgId)).toEqual(['orgA']);
    expect(await vectorStore.search(q, { orgId: 'orgA', knowledgeBaseIds: ['other-kb'], limit: 5 })).toEqual([]);
    expect(await vectorStore.search(embed('quantum chromodynamics lattice'), { orgId: 'orgA', knowledgeBaseIds: ['kb1'], limit: 5, threshold: 0.5 })).toEqual([]);
    await vectorStore.deleteByDocument('orgA', docId);
    expect(await qdrantCount({ must: [{ key: 'orgId', match: { value: 'orgA' } }, { key: 'documentId', match: { value: docId } }] })).toBe(0);
    expect(await qdrantCount({ must: [{ key: 'orgId', match: { value: 'orgB' } }, { key: 'documentId', match: { value: docId } }] })).toBe(1); // other tenant untouched
  });
});

describe('real LLM client retry + fallback (against the fake provider)', () => {
  it('retries the primary model, then falls back; reports the model actually used', async () => {
    await control({ failPrimary: true, chatCalls: [] });
    const r = await chat({ messages: [{ role: 'user', content: 'hi' }], sleepImpl: () => Promise.resolve() });
    expect(r.model).toBe('fallback'); const calls = await control({}); expect(calls.chatCalls.filter((m) => m === 'primary').length).toBe(3); expect(calls.chatCalls.at(-1)).toBe('fallback');
    await control({ failPrimary: false });
  });
});

describe('document extraction (real PDF and DOCX parsers)', () => {
  it('extracts text from a real PDF and a real DOCX', async () => {
    expect(await extractText(makePdf('Refund window is thirty days'), 'pdf')).toMatch(/Refund window is thirty days/);
    expect(await extractText(await makeDocx('Shipping is free over fifty dollars'), 'docx')).toMatch(/Shipping is free over fifty dollars/);
  });
});

describe('END-TO-END: upload → S3 → BullMQ worker → embeddings → Qdrant → retrieval', () => {
  let A, B, ua, ub, kbA, kbB, agentA, agentB;
  const upload = (u, org, kb, buf, name, type) => request(app).post(`/api/v1/orgs/${org.id}/knowledge-bases/${kb.id}/documents`).set(bearer(u.id)).attach('file', buf, { filename: name, contentType: type });
  const search = (u, org, kb, agent, query) => request(app).post(`/api/v1/orgs/${org.id}/knowledge-bases/${kb.id}/search-test`).set(bearer(u.id)).send({ agentId: agent.id, query });
  beforeAll(async () => {
    A = await makeOrg('growth'); B = await makeOrg('growth'); ua = await makeUser(A.id); ub = await makeUser(B.id);
    kbA = await prisma.knowledgeBase.create({ data: { orgId: A.id, name: 'A' } }); kbB = await prisma.knowledgeBase.create({ data: { orgId: B.id, name: 'B' } });
    agentA = await prisma.agent.create({ data: { orgId: A.id, name: 'a' } }); agentB = await prisma.agent.create({ data: { orgId: B.id, name: 'b' } });
    await prisma.agentKnowledgeBase.create({ data: { agentId: agentA.id, knowledgeBaseId: kbA.id } }); await prisma.agentKnowledgeBase.create({ data: { agentId: agentB.id, knowledgeBaseId: kbB.id } });
  });
  it('TXT, PDF and DOCX all become READY via the worker, with chunks in MySQL and vectors in Qdrant', async () => {
    const t = await upload(ua, A, kbA, Buffer.from('Our refund window is thirty days for all purchases.\n\nShipping is free over fifty dollars.'), 'policy.txt', 'text/plain'); expect(t.status).toBe(201);
    const p = await upload(ua, A, kbA, makePdf('Warranty covers manufacturing defects for two years'), 'warranty.pdf', 'application/pdf'); expect(p.status).toBe(201);
    const d = await upload(ua, A, kbA, await makeDocx('Support hours are nine to five on weekdays'), 'hours.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); expect(d.status).toBe(201);
    for (const id of [t, p, d].map((x) => x.body.data.id)) await waitFor(async () => (await prisma.knowledgeDocument.findUnique({ where: { id } })).status === 'READY');
    for (const id of [t, p, d].map((x) => x.body.data.id)) { expect(await prisma.documentChunk.count({ where: { documentId: id } })).toBeGreaterThan(0); expect(await qdrantCount({ must: [{ key: 'documentId', match: { value: id } }] })).toBeGreaterThan(0); }
    expect(await storage.get(t.body.data.storageKey)).toBeTruthy(); // really in S3
    expect(await getPeriodUsage(A.id, 'EMBEDDING_TOKENS')).toBeGreaterThan(0);
  });
  it('retrieval returns cited answers for the owner, and NOTHING for another tenant (even with a poisoned DB link)', async () => {
    const ok = await search(ua, A, kbA, agentA, 'how long is the refund window'); expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ answerable: true }); expect(ok.body.data.chunks[0].citation.filename).toBe('policy.txt'); expect(ok.body.data.chunks[0].text).toMatch(/refund window/);
    const none = await search(ua, A, kbA, agentA, 'quantum chromodynamics lattice gauge'); expect(none.body.data).toMatchObject({ answerable: false, reason: 'NO_RELEVANT_KNOWLEDGE' });
    await upload(ub, B, kbB, Buffer.from('Our cafeteria menu includes soup and sandwiches.'), 'menu.txt', 'text/plain'); await waitFor(async () => (await prisma.knowledgeDocument.count({ where: { orgId: B.id, status: 'READY' } })) === 1);
    expect((await search(ub, B, kbB, agentB, 'how long is the refund window')).body.data.answerable).toBe(false); // B cannot see A's policy
    await prisma.agentKnowledgeBase.create({ data: { agentId: agentB.id, knowledgeBaseId: kbA.id } }); // simulate a bad/malicious link written straight to the DB
    expect((await search(ub, B, kbB, agentB, 'how long is the refund window')).body.data.answerable).toBe(false);
    expect((await search(ub, B, kbA, agentB, 'x')).status).toBe(404); // and API access to A's KB is a 404
  });
  it('reprocess is idempotent; delete removes S3 object, chunks and vectors for that tenant only', async () => {
    const doc = await prisma.knowledgeDocument.findFirst({ where: { orgId: A.id, filename: 'policy.txt' } }); const before = await qdrantCount({ must: [{ key: 'documentId', match: { value: doc.id } }] });
    expect((await request(app).post(`/api/v1/orgs/${A.id}/knowledge-bases/${kbA.id}/documents/${doc.id}/reprocess`).set(bearer(ua.id))).status).toBe(200);
    await waitFor(async () => { const d = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } }); return d.status === 'READY'; }); await new Promise((r) => setTimeout(r, 300));
    expect(await qdrantCount({ must: [{ key: 'documentId', match: { value: doc.id } }] })).toBe(before); // no duplicate vectors
    expect((await request(app).delete(`/api/v1/orgs/${A.id}/knowledge-bases/${kbA.id}/documents/${doc.id}`).set(bearer(ua.id))).status).toBe(200);
    expect(await qdrantCount({ must: [{ key: 'documentId', match: { value: doc.id } }] })).toBe(0); expect(await prisma.documentChunk.count({ where: { documentId: doc.id } })).toBe(0); await expect(storage.get(doc.storageKey)).rejects.toBeTruthy();
    expect(await prisma.knowledgeDocument.count({ where: { orgId: B.id } })).toBe(1);
  });
  it('a corrupt upload that passes the type check fails in the worker and is marked FAILED (not stuck)', async () => {
    const bad = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('this is not really a pdf structure')]);
    const r = await upload(ua, A, kbA, bad, 'broken.pdf', 'application/pdf'); expect(r.status).toBe(201);
    const failed = await waitFor(async () => { const d = await prisma.knowledgeDocument.findUnique({ where: { id: r.body.data.id } }); return d.status === 'FAILED' ? d : null; }, 40000);
    expect(failed.error).toBeTruthy();
  });
});

describe('END-TO-END: call finished → BullMQ post-call worker → LLM → stored analysis + memory + metering', () => {
  it('analysis is validated and stored, caller memory written (hashed), tokens metered once', async () => {
    const org = await makeOrg('growth'); const agent = await prisma.agent.create({ data: { orgId: org.id, name: 'a' } });
    const v = await prisma.agentVersion.create({ data: { agentId: agent.id, version: 1, config: { systemPrompt: 's', extraction: [] } } });
    const call = await prisma.call.create({ data: { orgId: org.id, agentId: agent.id, agentVersionId: v.id, direction: 'INBOUND', status: 'COMPLETED', fromNumber: '+14155550177' } });
    await prisma.transcriptSegment.createMany({ data: [{ callId: call.id, seq: 0, speaker: 'customer', text: 'What is your refund policy? my email is jo@x.com' }, { callId: call.id, seq: 1, speaker: 'agent', text: 'Thirty days.' }] });
    await enqueue(QUEUES.postCall, { callId: call.id }, { jobId: `postcall-${call.id}` }); await enqueue(QUEUES.postCall, { callId: call.id }, { jobId: `postcall-${call.id}` }); // duplicate enqueue
    const done = await waitFor(async () => { const c = await prisma.call.findUnique({ where: { id: call.id } }); return c.analysis ? c : null; });
    expect(done.analysis).toMatchObject({ outcome: 'resolved', qualityScore: 9 }); expect(done.summary).toBe('Caller asked about refunds');
    expect(await prisma.conversationMemory.count({ where: { orgId: org.id } })).toBe(1); expect(JSON.stringify(await prisma.conversationMemory.findMany({ where: { orgId: org.id } }))).not.toContain('4155550177');
    await new Promise((r) => setTimeout(r, 400)); expect(await getPeriodUsage(org.id, 'LLM_TOKENS')).toBe(77); // metered once despite duplicate enqueue
  });
});
