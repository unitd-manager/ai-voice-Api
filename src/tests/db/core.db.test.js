import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { realPrisma as prisma } from './db-client.js';
import { resetDb } from './helpers.js';
import { createApp } from '../../app.js';
import { setTransportForTests } from '../../platform-services/email/email.service.js';
import { setVoiceProviderForTests } from '../../ai-platform/voice-engine/provider.factory.js';
import { createVapiAdapter } from '../../ai-platform/voice-engine/vapi.adapter.js';

const app = createApp();
let mails = [];
const lastToken = (re) => { const m = [...mails].reverse().find((x) => re.test(x.subject)); return /token=([\w-]+)/.exec(m.text)[1]; };
const PW = 'correct-horse-battery';
const cfg = { systemPrompt: 'Be helpful', model: {} };
const auth = (t) => ({ Authorization: `Bearer ${t}` });
async function signup(email) {
  const r = await request(app).post('/api/v1/auth/register').send({ email, password: PW, name: email.split('@')[0] });
  expect(r.status).toBe(201);
  return { token: r.body.data.tokens.accessToken, refresh: r.body.data.tokens.refreshToken, orgId: r.body.data.organization.id, userId: r.body.data.user.id };
}
beforeAll(async () => { await resetDb(); });
beforeEach(() => { mails = []; setTransportForTests({ sendMail: async (m) => { mails.push(m); } }); setVoiceProviderForTests(undefined); });

describe('auth against a real database', () => {
  it('register creates user + org + OWNER membership + TRIALING subscription atomically; duplicates rejected', async () => {
    const a = await signup('alice@x.co');
    const m = await prisma.membership.findFirst({ where: { userId: a.userId, orgId: a.orgId } }); expect(m.role).toBe('OWNER');
    const s = await prisma.subscription.findFirst({ where: { orgId: a.orgId }, include: { plan: true } }); expect(s).toMatchObject({ status: 'TRIALING' }); expect(s.plan.code).toBe('trial');
    expect((await prisma.user.findUnique({ where: { id: a.userId } })).passwordHash).not.toContain(PW);
    expect((await request(app).post('/api/v1/auth/register').send({ email: 'ALICE@x.co', password: PW })).status).toBe(409);
    expect((await request(app).post('/api/v1/auth/register').send({ email: 'weak@x.co', password: 'short' })).status).toBe(400);
  });
  it('login: right/wrong password; email verification token is single-use', async () => {
    await signup('bob@x.co');
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'bob@x.co', password: 'nope-nope-nope' })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'bob@x.co', password: PW })).status).toBe(200);
    const t = lastToken(/Verify/);
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token: t })).status).toBe(200);
    expect((await prisma.user.findUnique({ where: { email: 'bob@x.co' } })).emailVerifiedAt).toBeTruthy();
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token: t })).status).toBe(400);
  });
  it('refresh rotates; replaying an old token kills the whole family', async () => {
    const a = await signup('carol@x.co');
    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: a.refresh }); expect(r1.status).toBe(200);
    const fresh = r1.body.data.refreshToken;
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: a.refresh })).status).toBe(401); // reuse
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: fresh })).status).toBe(401);     // family revoked
  });
  it('concurrent refresh with one token: exactly one wins (atomic rotation)', async () => {
    const a = await signup('dave@x.co');
    const rs = await Promise.all(Array.from({ length: 6 }, () => request(app).post('/api/v1/auth/refresh').send({ refreshToken: a.refresh })));
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
  });
  it('password reset: token single-use, old sessions revoked, new password works', async () => {
    const a = await signup('erin@x.co');
    expect((await request(app).post('/api/v1/auth/forgot-password').send({ email: 'erin@x.co' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/forgot-password').send({ email: 'ghost@x.co' })).status).toBe(200); // no enumeration
    const t = lastToken(/Reset/);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: t, password: 'a-brand-new-password' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: t, password: 'another-password-1' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: a.refresh })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'erin@x.co', password: 'a-brand-new-password' })).status).toBe(200);
  });
  it('logout revokes the session family', async () => {
    const a = await signup('frank@x.co');
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: a.refresh });
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: a.refresh })).status).toBe(401);
  });
});

describe('tenant isolation + RBAC with real data', () => {
  let A, B;
  beforeAll(async () => { A = await signup('tenant-a@x.co'); B = await signup('tenant-b@x.co'); });
  it('cross-tenant org/agent access is 404 in every direction', async () => {
    const ag = await request(app).post(`/api/v1/orgs/${A.orgId}/agents`).set(auth(A.token)).send({ name: 'A-agent', config: cfg }); expect(ag.status).toBe(201);
    const id = ag.body.data.id;
    expect((await request(app).get(`/api/v1/orgs/${A.orgId}/agents/${id}`).set(auth(A.token))).status).toBe(200);
    expect((await request(app).get(`/api/v1/orgs/${A.orgId}/agents`).set(auth(B.token))).status).toBe(404);          // B → A's org
    expect((await request(app).get(`/api/v1/orgs/${B.orgId}/agents/${id}`).set(auth(B.token))).status).toBe(404);    // B → own org, A's id
    expect((await request(app).patch(`/api/v1/orgs/${B.orgId}/agents/${id}`).set(auth(B.token)).send({ name: 'pwn' })).status).toBe(404);
    expect((await request(app).delete(`/api/v1/orgs/${B.orgId}/agents/${id}`).set(auth(B.token))).status).toBe(404);
    expect((await prisma.agent.findUnique({ where: { id } })).name).toBe('A-agent');
    expect((await request(app).get(`/api/v1/orgs/${B.orgId}/agents`).set(auth(B.token))).body.data).toEqual([]);   // lists never leak
  });
  it('cannot attach another tenant\'s knowledge base or tool to your agent', async () => {
    const kb = await prisma.knowledgeBase.create({ data: { orgId: B.orgId, name: 'B-kb' } });
    const r = await request(app).post(`/api/v1/orgs/${A.orgId}/agents`).set(auth(A.token)).send({ name: 'x', config: cfg, knowledgeBaseIds: [kb.id] }); expect(r.status).toBe(400);
    expect(await prisma.agent.count({ where: { orgId: A.orgId, name: 'x' } })).toBe(0); // transaction rolled back
  });
  it('API keys: org-bound, hashed at rest, revocable', async () => {
    const k = await request(app).post(`/api/v1/orgs/${A.orgId}/api-keys`).set(auth(A.token)).send({ name: 'ci', role: 'VIEWER' }); expect(k.status).toBe(201);
    const key = k.body.data.key; const row = await prisma.apiKey.findUnique({ where: { id: k.body.data.id } });
    expect(row.keyHash).not.toBe(key); expect(JSON.stringify(row)).not.toContain(key);
    expect((await request(app).get(`/api/v1/orgs/${A.orgId}/agents`).set('x-api-key', key)).status).toBe(200);
    expect((await request(app).post(`/api/v1/orgs/${A.orgId}/agents`).set('x-api-key', key).send({ name: 'z', config: cfg })).status).toBe(403); // VIEWER key
    expect((await request(app).get(`/api/v1/orgs/${B.orgId}/agents`).set('x-api-key', key)).status).toBe(404);
    expect((await request(app).delete(`/api/v1/orgs/${A.orgId}/api-keys/${row.id}`).set(auth(A.token))).status).toBe(200);
    expect((await request(app).get(`/api/v1/orgs/${A.orgId}/agents`).set('x-api-key', key)).status).toBe(401);
    expect((await request(app).delete(`/api/v1/orgs/${B.orgId}/api-keys/${row.id}`).set(auth(B.token))).status).toBe(404); // not B's key
  });
  it('invitation flow: invited email only; role enforced; last-owner guard; removal', async () => {
    mails = [];
    expect((await request(app).post(`/api/v1/orgs/${A.orgId}/invitations`).set(auth(A.token)).send({ email: 'tenant-b@x.co', role: 'VIEWER' })).status).toBe(201);
    const t = lastToken(/invited/);
    const C = await signup('tenant-c@x.co');
    expect((await request(app).post('/api/v1/orgs/invitations/accept').set(auth(C.token)).send({ token: t })).status).toBe(400); // wrong user
    expect((await request(app).post('/api/v1/orgs/invitations/accept').set(auth(B.token)).send({ token: t })).status).toBe(200);
    expect((await request(app).post('/api/v1/orgs/invitations/accept').set(auth(B.token)).send({ token: t })).status).toBe(400); // single use
    expect((await request(app).get(`/api/v1/orgs/${A.orgId}/agents`).set(auth(B.token))).status).toBe(200);
    expect((await request(app).post(`/api/v1/orgs/${A.orgId}/agents`).set(auth(B.token)).send({ name: 'n', config: cfg })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/orgs/${A.orgId}/members/${B.userId}`).set(auth(B.token)).send({ role: 'OWNER' })).status).toBe(403); // self-escalation
    expect((await request(app).patch(`/api/v1/orgs/${A.orgId}/members/${A.userId}`).set(auth(A.token)).send({ role: 'VIEWER' })).status).toBe(409); // last owner
    expect((await request(app).delete(`/api/v1/orgs/${A.orgId}/members/${A.userId}`).set(auth(A.token))).status).toBe(409);
    expect((await request(app).delete(`/api/v1/orgs/${A.orgId}/members/${B.userId}`).set(auth(A.token))).status).toBe(200);
    expect((await request(app).get(`/api/v1/orgs/${A.orgId}/agents`).set(auth(B.token))).status).toBe(404); // access gone immediately
    const logs = await request(app).get(`/api/v1/orgs/${A.orgId}/audit-logs`).set(auth(A.token)); expect(logs.body.data.map((l) => l.action)).toEqual(expect.arrayContaining(['member.invite', 'member.remove', 'agent.create']));
  });
});

describe('agents lifecycle on a real database', () => {
  let O; const url = (p = '') => `/api/v1/orgs/${O.orgId}/agents${p}`;
  beforeAll(async () => { O = await signup('agents-owner@x.co'); });
  it('create → update(v2) → rollback(v3) → versions; list pagination walks all rows without duplicates', async () => {
    const c = await request(app).post(url()).set(auth(O.token)).send({ name: 'Ava', config: cfg }); const id = c.body.data.id;
    expect(c.body.data.currentVersion.version).toBe(1);
    const u = await request(app).patch(url(`/${id}`)).set(auth(O.token)).send({ config: { ...cfg, systemPrompt: 'v2 prompt' }, note: 'tweak' }); expect(u.body.data.currentVersion.version).toBe(2);
    const rb = await request(app).post(url(`/${id}/rollback`)).set(auth(O.token)).send({ version: 1 }); expect(rb.body.data.currentVersion).toMatchObject({ version: 3, note: 'Rollback to v1' }); expect(rb.body.data.currentVersion.config.systemPrompt).toBe('Be helpful');
    expect((await request(app).get(url(`/${id}/versions`)).set(auth(O.token))).body.data.map((v) => v.version)).toEqual([3, 2, 1]);
    for (let i = 0; i < 4; i++) await request(app).post(url()).set(auth(O.token)).send({ name: `bulk-${i}`, config: cfg });
    const seen = []; let cursor;
    for (let page = 0; page < 10; page++) { const r = await request(app).get(url(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).set(auth(O.token)); seen.push(...r.body.data.map((a) => a.id)); cursor = r.body.meta.nextCursor; if (!cursor) break; }
    expect(seen.length).toBe(5); expect(new Set(seen).size).toBe(5);
  });
  it('duplicate, archive, soft-delete (hidden everywhere afterwards)', async () => {
    const c = await request(app).post(url()).set(auth(O.token)).send({ name: 'Orig', config: cfg }); const id = c.body.data.id;
    const d = await request(app).post(url(`/${id}/duplicate`)).set(auth(O.token)); expect(d.status).toBe(201); expect(d.body.data.name).toBe('Orig (copy)');
    expect((await request(app).post(url(`/${id}/archive`)).set(auth(O.token))).body.data.status).toBe('ARCHIVED');
    expect((await request(app).delete(url(`/${id}`)).set(auth(O.token))).status).toBe(200);
    expect((await request(app).get(url(`/${id}`)).set(auth(O.token))).status).toBe(404);
    expect((await prisma.agent.findUnique({ where: { id } })).deletedAt).toBeTruthy();
  });
  it('publish sends the built assistant to the provider and stores its id; editing a published agent returns it to DRAFT', async () => {
    const tool = await prisma.toolDefinition.create({ data: { orgId: O.orgId, name: 'order_lookup', kind: 'order_lookup', description: 'orders', paramsSchema: {}, config: { url: 'https://api.shop.test/o' } } });
    const kb = await prisma.knowledgeBase.create({ data: { orgId: O.orgId, name: 'kb' } });
    const c = await request(app).post(url()).set(auth(O.token)).send({ name: 'Pub', config: { ...cfg, model: { name: 'gpt-4o-mini', temperature: 0.3, maxTokens: 200 }, transferRules: [{ phoneNumber: '+14155550999', condition: 'human' }] }, toolIds: [tool.id], knowledgeBaseIds: [kb.id] }); expect(c.status).toBe(201);
    const f = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'asst_real' }) }); setVoiceProviderForTests(createVapiAdapter({ apiKey: 'k', fetchImpl: f }));
    const p = await request(app).post(url(`/${c.body.data.id}/publish`)).set(auth(O.token)); expect(p.status).toBe(200); expect(p.body.data).toMatchObject({ status: 'PUBLISHED', providerAssistantId: 'asst_real' });
    expect(JSON.parse(f.mock.calls[0][1].body).model.tools.map((t) => t.function?.name ?? t.type)).toEqual(['order_lookup', 'search_knowledge', 'transferCall']);
    const e = await request(app).patch(url(`/${c.body.data.id}`)).set(auth(O.token)).send({ config: { ...cfg, systemPrompt: 'changed' } }); expect(e.body.data.status).toBe('DRAFT');
    const g = await request(app).patch(url(`/${c.body.data.id}`)).set(auth(O.token)).send({ toolIds: [] }); expect(g.status).toBe(200); expect(await prisma.agentTool.count({ where: { agentId: c.body.data.id } })).toBe(0);
  });
  it('input validation rejects bad configs before touching the DB', async () => {
    const bad = [{ name: '', config: cfg }, { name: 'x', config: { ...cfg, extra: 1 } }, { name: 'x', config: { ...cfg, transferRules: [{ phoneNumber: '123', condition: 'x' }] } }, { name: 'x', config: { systemPrompt: '' } }];
    for (const b of bad) expect((await request(app).post(url()).set(auth(O.token)).send(b)).status).toBe(400);
  });
});

describe('account lifecycle', () => {
  it('data export; deletion anonymizes, kills sessions and blocks login', async () => {
    const a = await signup('leaver@x.co');
    const ex = await request(app).get('/api/v1/users/me/export').set(auth(a.token)); expect(ex.status).toBe(200); expect(JSON.stringify(ex.body)).not.toMatch(/passwordHash/);
    expect((await request(app).post('/api/v1/users/me/delete').set(auth(a.token)).send({ password: 'wrong-wrong-wrong' })).status).toBe(401);
    expect((await request(app).post('/api/v1/users/me/delete').set(auth(a.token)).send({ password: PW })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: a.refresh })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'leaver@x.co', password: PW })).status).toBe(401);
    expect((await prisma.user.findUnique({ where: { id: a.userId } })).email).toMatch(/^deleted\+/);
  });
  it('deleting an organization row cascades to all tenant data (FKs are correct)', async () => {
    const a = await signup('cascade@x.co');
    await request(app).post(`/api/v1/orgs/${a.orgId}/agents`).set(auth(a.token)).send({ name: 'c', config: cfg });
    await prisma.organization.delete({ where: { id: a.orgId } });
    for (const t of ['agent', 'membership', 'subscription', 'agentVersion']) expect(await prisma[t].count({ where: t === 'agentVersion' ? { agent: { orgId: a.orgId } } : { orgId: a.orgId } })).toBe(0);
  });
});
