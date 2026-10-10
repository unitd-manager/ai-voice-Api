import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prismaMock, resetPrismaMock } from '../fixtures/prisma-mock.js';
import { fakeRedis } from '../fixtures/fake-redis.js';

vi.mock('../../platform-services/storage/storage.service.js', () => ({ storage: { get: vi.fn().mockResolvedValue(Buffer.from('RIFF')), put: vi.fn().mockResolvedValue(), delete: vi.fn().mockResolvedValue(), driver: 'mock' } }));
const stripeMock = { checkout: { sessions: { create: vi.fn() } }, invoiceItems: { create: vi.fn() }, subscriptions: { retrieve: vi.fn() }, customers: { create: vi.fn() }, billingPortal: { sessions: { create: vi.fn() } } };
vi.mock('../../saas-platform/payments/stripe.client.js', () => ({ getStripe: () => stripeMock }));

const { createApp } = await import('../../app.js');
const { signAccessToken } = await import('../../core/security/tokens.js');
const { clearMeterCache } = await import('../../saas-platform/usage-metering/api-meter.js');
const { idempotent } = await import('../../core/middleware/idempotency.js');
const { setVoiceProviderForTests } = await import('../../ai-platform/voice-engine/provider.factory.js');
const { createVapiAdapter } = await import('../../ai-platform/voice-engine/vapi.adapter.js');
const { hashPassword, sha256 } = await import('../../core/security/crypto.js');
const { billOverage, billingService, reconcileBilling } = await import('../../saas-platform/billing/billing.service.js');
const { enqueue } = await import('../../platform-services/background-jobs/queues.js');
const { storage } = await import('../../platform-services/storage/storage.service.js');

const app = createApp();
const bearer = (uid = 'u1') => ({ Authorization: `Bearer ${signAccessToken(uid)}` });
const asRole = (role, org = {}) => prismaMock.membership.findUnique.mockResolvedValue({ role, org: { deletedAt: null, suspendedAt: null, ...org } });
const sub = (ent = {}) => prismaMock.subscription.findFirst.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'p', entitlements: { concurrentCalls: 5, phoneNumbers: 2, storageBytes: -1, apiRequestsPerMonth: -1, callMinutes: 100, ...ent } } });
const P2002 = Object.assign(new Error('dup'), { code: 'P2002' });
beforeEach(() => { resetPrismaMock(); fakeRedis._reset(); clearMeterCache(); vi.clearAllMocks(); setVoiceProviderForTests(undefined); });

describe('API request metering', () => {
  it('counts per org and returns 429 API_QUOTA_EXCEEDED once the monthly limit is passed', async () => {
    asRole('VIEWER'); sub({ apiRequestsPerMonth: 2 }); prismaMock.agent.findMany.mockResolvedValue([]);
    expect((await request(app).get('/api/v1/orgs/O/agents').set(bearer())).status).toBe(200);
    expect((await request(app).get('/api/v1/orgs/O/agents').set(bearer())).status).toBe(200);
    const r = await request(app).get('/api/v1/orgs/O/agents').set(bearer());
    expect(r.status).toBe(429); expect(r.body.error.code).toBe('API_QUOTA_EXCEEDED');
  });
  it('billing endpoints stay reachable over quota', async () => {
    asRole('ADMIN'); sub({ apiRequestsPerMonth: 1 }); prismaMock.agent.findMany.mockResolvedValue([]); prismaMock.usageAggregate.findUnique.mockResolvedValue(null);
    await request(app).get('/api/v1/orgs/O/agents').set(bearer()); await request(app).get('/api/v1/orgs/O/agents').set(bearer());
    expect((await request(app).get('/api/v1/orgs/O/billing').set(bearer())).status).toBe(200);
  });
  it('fails OPEN when Redis is down (metering must not take the API down)', async () => {
    asRole('VIEWER'); sub({ apiRequestsPerMonth: 1 }); prismaMock.agent.findMany.mockResolvedValue([]);
    const spy = vi.spyOn(fakeRedis, 'incr').mockRejectedValue(new Error('redis down'));
    expect((await request(app).get('/api/v1/orgs/O/agents').set(bearer())).status).toBe(200); spy.mockRestore();
  });
});

describe('Idempotency-Key middleware', () => {
  const mk = () => { let runs = 0; const a = express(); a.use(express.json()); a.use((req, _r, n) => { req.org = { id: 'O' }; n(); }); a.post('/x', idempotent, (req, res) => { runs++; res.status(201).json({ n: runs }); }); return { a, runs: () => runs }; };
  it('runs once and replays the stored response for the same key + body', async () => {
    const { a, runs } = mk(); const k = 'key-12345678';
    const r1 = await request(a).post('/x').set('Idempotency-Key', k).send({ v: 1 });
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await request(a).post('/x').set('Idempotency-Key', k).send({ v: 1 });
    expect(r1.status).toBe(201); expect(r2.status).toBe(201); expect(r2.body).toEqual(r1.body); expect(r2.headers['idempotent-replay']).toBe('true'); expect(runs()).toBe(1);
  });
  it('rejects the same key with a different body (422)', async () => {
    const { a } = mk(); const k = 'key-abcdefgh';
    await request(a).post('/x').set('Idempotency-Key', k).send({ v: 1 }); await new Promise((r) => setTimeout(r, 20));
    expect((await request(a).post('/x').set('Idempotency-Key', k).send({ v: 2 })).status).toBe(422);
  });
  it('rejects malformed keys and ignores requests without a key', async () => {
    const { a, runs } = mk();
    expect((await request(a).post('/x').set('Idempotency-Key', 'short').send({})).status).toBe(400);
    await request(a).post('/x').send({}); await request(a).post('/x').send({}); expect(runs()).toBe(2);
  });
});

describe('organization suspension', () => {
  it('blocks every tenant route with 403 ORG_SUSPENDED (users and API keys)', async () => {
    asRole('OWNER', { suspendedAt: new Date() });
    const r = await request(app).get('/api/v1/orgs/O/agents').set(bearer()); expect(r.status).toBe(403); expect(r.body.error.code).toBe('ORG_SUSPENDED');
    prismaMock.apiKey.findUnique.mockResolvedValue({ id: 'k', orgId: 'O', role: 'ADMIN', revokedAt: null }); prismaMock.apiKey.update.mockResolvedValue({});
    prismaMock.organization.findUnique.mockResolvedValue({ deletedAt: null, suspendedAt: new Date() });
    expect((await request(app).get('/api/v1/orgs/O/agents').set('x-api-key', 'va_x')).body.error.code).toBe('ORG_SUSPENDED');
  });
});

describe('platform admin API', () => {
  const asAdmin = (is) => prismaMock.user.findUnique.mockResolvedValue({ isPlatformAdmin: is, disabledAt: null, deletedAt: null });
  it('403 for regular users and API keys; flag is re-read from the DB each time', async () => {
    asAdmin(false); expect((await request(app).get('/api/v1/admin/orgs').set(bearer())).status).toBe(403);
    prismaMock.apiKey.findUnique.mockResolvedValue({ id: 'k', orgId: 'O', role: 'ADMIN', revokedAt: null }); prismaMock.apiKey.update.mockResolvedValue({});
    expect((await request(app).get('/api/v1/admin/orgs').set('x-api-key', 'va_x')).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/orgs')).status).toBe(401);
  });
  it('lists orgs for admins with pagination', async () => { asAdmin(true); prismaMock.organization.findMany.mockResolvedValue([{ id: 'o1' }]); const r = await request(app).get('/api/v1/admin/orgs?limit=5').set(bearer()); expect(r.status).toBe(200); expect(r.body.meta.limit).toBe(5); });
  it('suspend is audited', async () => { asAdmin(true); prismaMock.organization.updateMany.mockResolvedValue({ count: 1 }); prismaMock.auditLog.create.mockResolvedValue({}); const r = await request(app).post('/api/v1/admin/orgs/o1/suspend').set(bearer()); expect(r.status).toBe(200); expect(prismaMock.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'admin.org.suspend', orgId: 'o1' }) }); });
  it('credit grants require an idempotency key and a reason; duplicates are no-ops', async () => {
    asAdmin(true); prismaMock.creditAccount.createMany.mockResolvedValue({}); prismaMock.creditAccount.findUnique.mockResolvedValue({ id: 'ca' }); prismaMock.creditTransaction.create.mockRejectedValue(P2002); prismaMock.auditLog.create.mockResolvedValue({});
    expect((await request(app).post('/api/v1/admin/orgs/o1/credits').set(bearer()).send({ amountMinor: 500 })).status).toBe(400);
    const r = await request(app).post('/api/v1/admin/orgs/o1/credits').set(bearer()).send({ amountMinor: 500, reason: 'goodwill', idempotencyKey: 'abc-12345' });
    expect(r.status).toBe(200); expect(r.body.data.duplicate).toBe(true);
  });
  it('system health never leaks secrets', async () => { asAdmin(true); prismaMock.webhookEvent.count.mockResolvedValue(2); const r = await request(app).get('/api/v1/admin/system/health').set(bearer()); expect(r.status).toBe(200); expect(JSON.stringify(r.body)).not.toMatch(/vapi-test-key|llm-key|sk_test/); expect(r.body.data.providers.vapi.status).toMatch(/ok|error/); expect(r.body.data.unprocessedWebhooks).toBe(2); });
});

describe('phone numbers', () => {
  const post = (body) => request(app).post('/api/v1/orgs/O/phone-numbers').set(bearer()).send(body);
  it('enforces the plan limit (403 PLAN_LIMIT)', async () => { asRole('DEVELOPER'); sub({ phoneNumbers: 1 }); prismaMock.phoneNumber.count.mockResolvedValue(1); const r = await post({ provider: 'vapi', areaCode: '415' }); expect(r.status).toBe(403); expect(r.body.error.code).toBe('PLAN_LIMIT'); });
  it('creates a provider number WITHOUT an assistantId (so inbound calls hit our server) and stores it for the org', async () => {
    asRole('DEVELOPER'); sub(); prismaMock.phoneNumber.count.mockResolvedValue(0); prismaMock.auditLog.create.mockResolvedValue({}); prismaMock.phoneNumber.create.mockImplementation(async ({ data }) => ({ id: 'pn', ...data }));
    const f = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'vp1', number: '+14155550111' }) });
    setVoiceProviderForTests(createVapiAdapter({ apiKey: 'k', fetchImpl: f }));
    const r = await post({ provider: 'vapi', areaCode: '415', monthlyCostMinor: 200 });
    expect(r.status).toBe(201); const sent = JSON.parse(f.mock.calls[0][1].body);
    expect(sent.assistantId).toBeUndefined(); expect(sent.server.url).toContain('/api/v1/webhooks/vapi');
    expect(prismaMock.phoneNumber.create).toHaveBeenCalledWith({ data: expect.objectContaining({ orgId: 'O', e164: '+14155550111', providerNumberId: 'vp1', monthlyCostMinor: 200 }) });
  });
  it('validates Twilio credentials shape before touching the provider', async () => { asRole('DEVELOPER'); expect((await post({ provider: 'twilio', number: '+14155550111', twilioAccountSid: 'bad', twilioAuthToken: 'x' })).status).toBe(400); });
  it('cannot assign a number to another tenant\'s agent', async () => { asRole('DEVELOPER'); prismaMock.phoneNumber.findFirst.mockResolvedValue({ id: 'pn' }); prismaMock.agent.findFirst.mockResolvedValue(null); expect((await request(app).patch('/api/v1/orgs/O/phone-numbers/pn').set(bearer()).send({ agentId: 'foreign' })).status).toBe(404); expect(prismaMock.agent.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ id: 'foreign', orgId: 'O' }) }); });
  it('release deletes at the provider then in the DB; viewers are forbidden', async () => {
    asRole('VIEWER'); expect((await request(app).delete('/api/v1/orgs/O/phone-numbers/pn').set(bearer())).status).toBe(403);
    asRole('DEVELOPER'); prismaMock.phoneNumber.findFirst.mockResolvedValue({ id: 'pn', providerNumberId: 'vp1' }); prismaMock.phoneNumber.delete.mockResolvedValue({}); prismaMock.auditLog.create.mockResolvedValue({});
    const f = vi.fn().mockResolvedValue({ ok: true, status: 204 }); setVoiceProviderForTests(createVapiAdapter({ apiKey: 'k', fetchImpl: f }));
    expect((await request(app).delete('/api/v1/orgs/O/phone-numbers/pn').set(bearer())).status).toBe(200); expect(f.mock.calls[0][0]).toContain('/phone-number/vp1');
  });
});

describe('agents (service behaviour over HTTP)', () => {
  const cfg = { systemPrompt: 'Be helpful', model: {}, transferRules: [{ phoneNumber: '+14155550999', condition: 'caller asks for a human' }] };
  it('rejects knowledge bases / tools from another tenant (400)', async () => { asRole('DEVELOPER'); prismaMock.knowledgeBase.count.mockResolvedValue(0); expect((await request(app).post('/api/v1/orgs/O/agents').set(bearer()).send({ name: 'A', config: cfg, knowledgeBaseIds: ['foreignKb'] })).status).toBe(400); expect(prismaMock.agent.create).not.toHaveBeenCalled(); });
  it('creates agent + v1 in one transaction', async () => {
    asRole('DEVELOPER'); prismaMock.agent.create.mockResolvedValue({ id: 'a1' }); prismaMock.agentVersion.create.mockResolvedValue({ id: 'v1' }); prismaMock.agent.update.mockResolvedValue({ id: 'a1', currentVersionId: 'v1' }); prismaMock.auditLog.create.mockResolvedValue({});
    const r = await request(app).post('/api/v1/orgs/O/agents').set(bearer()).send({ name: 'A', config: cfg }); expect(r.status).toBe(201);
    expect(prismaMock.agent.create).toHaveBeenCalledWith({ data: { orgId: 'O', name: 'A' } }); expect(prismaMock.agentVersion.create.mock.calls[0][0].data.version).toBe(1);
  });
  it('editing config creates v2 and moves a PUBLISHED agent back to DRAFT', async () => {
    asRole('DEVELOPER'); prismaMock.agent.findFirst.mockResolvedValue({ id: 'a1', status: 'PUBLISHED', currentVersionId: 'v1' }); prismaMock.agentVersion.findFirst.mockResolvedValue({ version: 1 }); prismaMock.agentVersion.create.mockResolvedValue({ id: 'v2' }); prismaMock.agent.update.mockResolvedValue({ id: 'a1' }); prismaMock.auditLog.create.mockResolvedValue({});
    expect((await request(app).patch('/api/v1/orgs/O/agents/a1').set(bearer()).send({ config: cfg })).status).toBe(200);
    expect(prismaMock.agentVersion.create.mock.calls[0][0].data.version).toBe(2);
    expect(prismaMock.agent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ currentVersionId: 'v2', status: 'DRAFT' }) }));
  });
  it('rollback copies the old config as a NEW version (history preserved)', async () => {
    asRole('DEVELOPER'); prismaMock.agent.findFirst.mockResolvedValue({ id: 'a1' }); prismaMock.agentVersion.findUnique.mockResolvedValue({ config: cfg }); prismaMock.agentVersion.findFirst.mockResolvedValue({ version: 3 }); prismaMock.agentVersion.create.mockResolvedValue({ id: 'v4' }); prismaMock.agent.update.mockResolvedValue({ id: 'a1' });
    expect((await request(app).post('/api/v1/orgs/O/agents/a1/rollback').set(bearer()).send({ version: 1 })).status).toBe(200);
    expect(prismaMock.agentVersion.create.mock.calls[0][0].data).toMatchObject({ version: 4, note: 'Rollback to v1' });
  });
  it('publish sends tools, knowledge search, transfer rules and our server URL to the provider', async () => {
    asRole('DEVELOPER'); prismaMock.auditLog.create.mockResolvedValue({}); prismaMock.agent.update.mockResolvedValue({ id: 'a1', status: 'PUBLISHED' });
    prismaMock.agent.findFirst.mockResolvedValue({ id: 'a1', orgId: 'O', name: 'Ava', providerAssistantId: null, currentVersion: { config: { ...cfg, model: { name: 'gpt-4o-mini', temperature: 0.3, maxTokens: 300 }, maxCallDurationSeconds: 600, silenceTimeoutSeconds: 20 } } });
    prismaMock.agentTool.findMany.mockResolvedValue([{ tool: { name: 'order_lookup', kind: 'order_lookup', description: 'Order status' } }]); prismaMock.agentKnowledgeBase.count.mockResolvedValue(1);
    const f = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 'asst_9' }) }); setVoiceProviderForTests(createVapiAdapter({ apiKey: 'k', fetchImpl: f }));
    expect((await request(app).post('/api/v1/orgs/O/agents/a1/publish').set(bearer())).status).toBe(200);
    const body = JSON.parse(f.mock.calls[0][1].body); const tools = body.model.tools;
    expect(tools.map((t) => t.function?.name ?? t.type)).toEqual(['order_lookup', 'search_knowledge', 'transferCall']);
    expect(tools[2].destinations[0].number).toBe('+14155550999'); expect(body.server.url).toContain('/webhooks/vapi'); expect(body.server.secret).toBe('vapi-test-secret');
    expect(prismaMock.agent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerAssistantId: 'asst_9', status: 'PUBLISHED' }) }));
  });
  it('a provider failure leaves the agent unpublished', async () => {
    asRole('DEVELOPER'); prismaMock.agent.findFirst.mockResolvedValue({ id: 'a1', orgId: 'O', name: 'A', currentVersion: { config: { ...cfg, model: { name: 'm', temperature: 0, maxTokens: 100 } } } }); prismaMock.agentTool.findMany.mockResolvedValue([]); prismaMock.agentKnowledgeBase.count.mockResolvedValue(0);
    setVoiceProviderForTests(createVapiAdapter({ apiKey: 'k', fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) }));
    expect((await request(app).post('/api/v1/orgs/O/agents/a1/publish').set(bearer())).status).toBe(502); expect(prismaMock.agent.update).not.toHaveBeenCalled();
  });
});

describe('Vapi server messages (inbound, tools, transfer)', () => {
  const H = { 'x-vapi-secret': 'vapi-test-secret' };
  const post = (message) => request(app).post('/api/v1/webhooks/vapi').set(H).send({ message });
  const number = { id: 'pn', orgId: 'O', agentId: 'a1', e164: '+14155550111' };
  const agent = { id: 'a1', orgId: 'O', name: 'Ava', status: 'PUBLISHED', currentVersionId: 'v1', currentVersion: { config: { systemPrompt: 'Be kind', model: { name: 'm', temperature: 0.1, maxTokens: 100 }, transferRules: [{ phoneNumber: '+14155550999', condition: 'x' }] } } };
  it('assistant-request: unknown number → spoken error, no assistant', async () => { prismaMock.phoneNumber.findFirst.mockResolvedValue(null); expect((await post({ type: 'assistant-request', call: { id: 'c', type: 'inboundPhoneCall' } })).body.error).toBeTruthy(); });
  it('assistant-request: no active subscription → refuses politely', async () => { prismaMock.phoneNumber.findFirst.mockResolvedValue(number); prismaMock.subscription.findFirst.mockResolvedValue(null); const r = await post({ type: 'assistant-request', call: { id: 'c', type: 'inboundPhoneCall', customer: { number: '+1999' } } }); expect(r.body.assistant).toBeUndefined(); expect(r.body.error).toMatch(/unable/); });
  it('assistant-request: returns a transient assistant with caller memory fenced as data', async () => {
    prismaMock.phoneNumber.findFirst.mockResolvedValue(number); sub(); prismaMock.agent.findFirst.mockResolvedValue(agent); prismaMock.agentTool.findMany.mockResolvedValue([]); prismaMock.agentKnowledgeBase.count.mockResolvedValue(0);
    prismaMock.conversationMemory.findUnique.mockResolvedValue({ summary: 'Prefers mornings', expiresAt: new Date(Date.now() + 1e6) });
    const r = await post({ type: 'assistant-request', call: { id: 'c', type: 'inboundPhoneCall', customer: { number: '+14155550100' } } });
    expect(r.status).toBe(200); expect(r.body.assistant.model.messages[0].content).toMatch(/<caller_memory>[\s\S]*Prefers mornings[\s\S]*<\/caller_memory>/); expect(r.body.assistant.model.tools[0].type).toBe('transferCall');
  });
  it('tool-calls on an unknown call returns a generic error result (no internals)', async () => {
    prismaMock.call.findUnique.mockResolvedValue(null);
    const r = await post({ type: 'tool-calls', call: { id: 'nope' }, toolCallList: [{ id: 't1', name: 'order_lookup', parameters: { orderId: '1' } }] });
    expect(r.status).toBe(200); expect(r.body.results[0]).toMatchObject({ toolCallId: 't1', name: 'order_lookup' }); expect(r.body.results[0].result).not.toMatch(/unknown_call|stack|prisma/i);
  });
  it('tool-calls: search_knowledge uses the call\'s own org/agent; denied tools return a safe error', async () => {
    prismaMock.call.findUnique.mockResolvedValue({ id: 'cl', orgId: 'O', agentId: 'a1' }); prismaMock.agentKnowledgeBase.findMany.mockResolvedValue([]); prismaMock.toolDefinition.findFirst.mockResolvedValue(null);
    const r = await post({ type: 'tool-calls', call: { id: 'pc' }, toolCallList: [{ id: 't1', name: 'search_knowledge', parameters: { query: 'refund policy' } }, { id: 't2', name: 'ticket_create', parameters: { subject: 's', description: 'd' } }] });
    expect(r.body.results[0].result).toMatch(/No relevant information/); expect(JSON.parse(r.body.results[1].result)).toEqual({ error: 'The tool could not complete this request.' });
    expect(prismaMock.agentKnowledgeBase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { agentId: 'a1', kb: { orgId: 'O' } } }));
  });
  it('transfer-destination-request returns the agent\'s configured number', async () => {
    prismaMock.call.findUnique.mockResolvedValue({ id: 'cl', orgId: 'O', agentId: 'a1', agentVersionId: 'v1' }); prismaMock.agentVersion.findUnique.mockResolvedValue(agent.currentVersion);
    expect((await post({ type: 'transfer-destination-request', call: { id: 'pc' } })).body.destination).toEqual({ type: 'number', number: '+14155550999' });
  });
  it('request/response messages with a bad secret are refused before any lookup', async () => { const r = await request(app).post('/api/v1/webhooks/vapi').set('x-vapi-secret', 'bad').send({ message: { type: 'tool-calls', toolCallList: [] } }); expect(r.status).toBe(401); expect(prismaMock.call.findUnique).not.toHaveBeenCalled(); });
  it('status-update for an unseen INBOUND call to our number creates the Call row', async () => {
    prismaMock.webhookEvent.create.mockResolvedValue({ id: 'w' }); prismaMock.webhookEvent.update.mockResolvedValue({});
    prismaMock.call.findUnique.mockResolvedValue(null); prismaMock.phoneNumber.findFirst.mockResolvedValue(number); prismaMock.agent.findFirst.mockResolvedValue(agent);
    prismaMock.call.create.mockResolvedValue({ id: 'newcall', orgId: 'O', status: 'IN_PROGRESS' }); prismaMock.callEvent.create.mockResolvedValue({});
    const r = await post({ type: 'status-update', status: 'in-progress', timestamp: 1, call: { id: 'pc9', type: 'inboundPhoneCall', phoneNumberId: 'vp', customer: { number: '+14155550100' } } });
    expect(r.status).toBe(200); expect(prismaMock.call.create).toHaveBeenCalledWith({ data: expect.objectContaining({ orgId: 'O', direction: 'INBOUND', providerCallId: 'pc9', fromNumber: '+14155550100' }) });
  });
  it('inbound call to a number that is NOT ours is ignored (no row created)', async () => {
    prismaMock.webhookEvent.create.mockResolvedValue({ id: 'w' }); prismaMock.webhookEvent.update.mockResolvedValue({}); prismaMock.call.findUnique.mockResolvedValue(null); prismaMock.phoneNumber.findFirst.mockResolvedValue(null);
    expect((await post({ type: 'status-update', status: 'in-progress', timestamp: 2, call: { id: 'pcX', type: 'inboundPhoneCall', phoneNumberId: 'zz' } })).status).toBe(200); expect(prismaMock.call.create).not.toHaveBeenCalled();
  });
});

describe('billing: overage, credits, reconciliation', () => {
  const inv = { id: 'in_1', customer: 'cus_1', currency: 'usd', status: 'draft', billing_reason: 'subscription_cycle', period_start: 1700000000, period_end: 1702592000 };
  beforeEach(() => { prismaMock.billingCustomer.findUnique.mockResolvedValue({ orgId: 'O' }); prismaMock.subscription.findFirst.mockResolvedValue({ plan: { entitlements: { callMinutes: 300, overageCentsPerMinute: 18 } } }); });
  const usage = (n) => prismaMock.usageEvent.aggregate.mockResolvedValue({ _sum: { quantity: BigInt(n) } });
  it('adds an invoice item for overage minutes at the plan rate (350 used, 300 included ⇒ 900¢)', async () => {
    usage(350); prismaMock.creditAccount.findUnique.mockResolvedValue(null);
    await billOverage(inv);
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1', invoice: 'in_1', amount: 900, currency: 'usd' }), { idempotencyKey: 'overage-item-in_1' });
  });
  it('applies prepaid credits first and bills only the remainder', async () => {
    usage(350); prismaMock.creditAccount.findUnique.mockResolvedValue({ id: 'ca', balanceMinor: 400 }); prismaMock.creditAccount.updateMany.mockResolvedValue({ count: 1 }); prismaMock.creditTransaction.create.mockResolvedValue({});
    await billOverage(inv); expect(stripeMock.invoiceItems.create.mock.calls[0][0].amount).toBe(500);
  });
  it('credits covering everything ⇒ no Stripe charge', async () => { usage(350); prismaMock.creditAccount.findUnique.mockResolvedValue({ id: 'ca', balanceMinor: 5000 }); prismaMock.creditAccount.updateMany.mockResolvedValue({ count: 1 }); prismaMock.creditTransaction.create.mockResolvedValue({}); await billOverage(inv); expect(stripeMock.invoiceItems.create).not.toHaveBeenCalled(); });
  it('replayed event after a Stripe failure does not re-spend credits and still bills the same remainder', async () => {
    usage(350); prismaMock.creditAccount.findUnique.mockResolvedValue({ id: 'ca', balanceMinor: 100 }); prismaMock.creditAccount.updateMany.mockResolvedValue({ count: 1 }); prismaMock.creditTransaction.create.mockRejectedValue(P2002); prismaMock.creditTransaction.findUnique.mockResolvedValue({ deltaMinor: -400 });
    await billOverage(inv); expect(stripeMock.invoiceItems.create.mock.calls[0][0].amount).toBe(500);
  });
  it.each([['within included usage', () => usage(250), inv], ['non-renewal invoice', () => usage(999), { ...inv, billing_reason: 'subscription_create' }], ['already finalized invoice', () => usage(999), { ...inv, status: 'open' }]])('no charge: %s', async (_n, setup, i) => { setup(); await billOverage(i); expect(stripeMock.invoiceItems.create).not.toHaveBeenCalled(); });
  it('unlimited plans are never charged overage', async () => { usage(99999); prismaMock.subscription.findFirst.mockResolvedValue({ plan: { entitlements: { callMinutes: -1, overageCentsPerMinute: 0 } } }); await billOverage(inv); expect(stripeMock.invoiceItems.create).not.toHaveBeenCalled(); });
  it('credit purchase: grants exactly amount_total once Stripe says paid; verifies customer↔org match', async () => {
    prismaMock.creditAccount.createMany.mockResolvedValue({}); prismaMock.creditAccount.findUnique.mockResolvedValue({ id: 'ca' }); prismaMock.creditAccount.update.mockResolvedValue({}); prismaMock.creditTransaction.create.mockResolvedValue({});
    const s = { id: 'cs_1', customer: 'cus_1', payment_status: 'paid', amount_total: 5000, metadata: { kind: 'credits', orgId: 'O' } };
    await billingService.handleStripeEvent({ type: 'checkout.session.completed', data: { object: s } });
    expect(prismaMock.creditTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ deltaMinor: 5000, idempotencyKey: 'stripe:cs_1' }) });
    await expect(billingService.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { ...s, metadata: { kind: 'credits', orgId: 'EVIL' } } } })).rejects.toThrow(/does not match/);
    prismaMock.creditTransaction.create.mockClear(); await billingService.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { ...s, payment_status: 'unpaid' } } }); expect(prismaMock.creditTransaction.create).not.toHaveBeenCalled();
  });
  it('credit checkout route: only server-defined packs, billing:manage only, idempotent', async () => {
    prismaMock.billingCustomer.findUnique.mockResolvedValue({ orgId: 'O', providerCustomerId: 'cus_1' }); stripeMock.checkout.sessions.create.mockResolvedValue({ url: 'https://stripe.test/pay' });
    asRole('VIEWER'); expect((await request(app).post('/api/v1/orgs/O/credits/checkout').set(bearer()).send({ amountMinor: 1000 })).status).toBe(403);
    asRole('ADMIN'); expect((await request(app).post('/api/v1/orgs/O/credits/checkout').set(bearer()).send({ amountMinor: 1 })).status).toBe(400);
    const h = { ...bearer(), 'Idempotency-Key': 'credit-key-1' };
    const a = await request(app).post('/api/v1/orgs/O/credits/checkout').set(h).send({ amountMinor: 5000 }); await new Promise((r) => setTimeout(r, 20));
    const b = await request(app).post('/api/v1/orgs/O/credits/checkout').set(h).send({ amountMinor: 5000 });
    expect(a.body.data.url).toBe('https://stripe.test/pay'); expect(b.headers['idempotent-replay']).toBe('true'); expect(stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(stripeMock.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(5000);
  });
  it('reconciliation repairs drift and marks vanished subscriptions canceled', async () => {
    prismaMock.subscription.findMany.mockResolvedValue([{ id: 's1', providerSubscriptionId: 'sub_1', status: 'ACTIVE' }, { id: 's2', providerSubscriptionId: 'sub_2', status: 'ACTIVE' }, { id: 's3', providerSubscriptionId: 'sub_3', status: 'ACTIVE' }]);
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ id: 'sub_1', customer: 'cus_1', status: 'canceled', items: { data: [{ price: { id: 'price_1' }, current_period_start: 1, current_period_end: 2 }] } })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'resource_missing' })).mockResolvedValueOnce({ id: 'sub_3', status: 'active' });
    prismaMock.planPrice.findFirst.mockResolvedValue({ planId: 'p', interval: 'MONTH' }); prismaMock.subscription.upsert.mockResolvedValue({}); prismaMock.subscription.update.mockResolvedValue({});
    const rep = await reconcileBilling();
    expect(rep).toEqual({ checked: 3, repaired: 2, errors: 0 }); expect(prismaMock.subscription.upsert.mock.calls[0][0].update.status).toBe('CANCELED'); expect(prismaMock.subscription.update).toHaveBeenCalledWith({ where: { id: 's2' }, data: expect.objectContaining({ status: 'CANCELED' }) });
  });
});

describe('knowledge uploads, tools, integrations, recordings', () => {
  it('upload: rejects mismatched bytes; stores under a server-generated key and enqueues ingestion', async () => {
    asRole('DEVELOPER'); sub(); prismaMock.knowledgeBase.findFirst.mockResolvedValue({ id: 'kb' }); prismaMock.knowledgeDocument.create.mockImplementation(async ({ data }) => data);
    const bad = await request(app).post('/api/v1/orgs/O/knowledge-bases/kb/documents').set(bearer()).attach('file', Buffer.from([0x4d, 0x5a, 0, 0, 1]), { filename: 'x.pdf', contentType: 'application/pdf' }); expect(bad.status).toBe(400);
    const ok = await request(app).post('/api/v1/orgs/O/knowledge-bases/kb/documents').set(bearer()).attach('file', Buffer.from('Hello policy'), { filename: '../../etc/passwd.txt', contentType: 'text/plain' });
    expect(ok.status).toBe(201); const key = storage.put.mock.calls[0][0]; expect(key).toMatch(/^orgs\/O\/kb\/kb\/[0-9a-f-]{36}$/); expect(key).not.toMatch(/passwd|\.\./); expect(ok.body.data.filename).not.toContain('/'); expect(enqueue).toHaveBeenCalledWith('document-ingestion', expect.any(Object), expect.any(Object));
  });
  it('upload: storage plan limit enforced (403)', async () => { asRole('DEVELOPER'); sub({ storageBytes: 10 }); prismaMock.knowledgeBase.findFirst.mockResolvedValue({ id: 'kb' }); prismaMock.knowledgeDocument.aggregate.mockResolvedValue({ _sum: { sizeBytes: 8 } }); const r = await request(app).post('/api/v1/orgs/O/knowledge-bases/kb/documents').set(bearer()).attach('file', Buffer.from('12345678'), { filename: 'a.txt', contentType: 'text/plain' }); expect(r.status).toBe(403); expect(storage.put).not.toHaveBeenCalled(); });
  it('upload into another tenant\'s KB is 404', async () => { asRole('DEVELOPER'); prismaMock.knowledgeBase.findFirst.mockResolvedValue(null); expect((await request(app).post('/api/v1/orgs/O/knowledge-bases/foreign/documents').set(bearer()).attach('file', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' })).status).toBe(404); expect(prismaMock.knowledgeBase.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', orgId: 'O' } }); });
  it('tools: private URLs rejected at creation; headers are stored encrypted and never returned', async () => {
    asRole('DEVELOPER'); prismaMock.auditLog.create.mockResolvedValue({}); prismaMock.toolDefinition.create.mockImplementation(async ({ data }) => ({ id: 't1', ...data }));
    const body = (url) => ({ name: 'order_lookup', kind: 'order_lookup', description: 'd', config: { url, headers: { Authorization: 'Bearer SECRET' } } });
    expect((await request(app).post('/api/v1/orgs/O/tools').set(bearer()).send(body('https://169.254.169.254/x'))).status).toBe(400);
    expect((await request(app).post('/api/v1/orgs/O/tools').set(bearer()).send(body('http://api.shop.test/x'))).status).toBe(400);
    expect((await request(app).post('/api/v1/orgs/O/tools').set(bearer()).send(body('https://api.shop.test/orders'))).status).toBe(201);
    expect(JSON.stringify(prismaMock.toolDefinition.create.mock.calls[0][0])).not.toContain('SECRET');
    prismaMock.toolDefinition.findMany.mockResolvedValue([{ id: 't1', name: 'n', config: { url: 'https://api.shop.test/orders', headersEnc: 'v1.a.b.c' } }]);
    expect(JSON.stringify((await request(app).get('/api/v1/orgs/O/tools').set(bearer())).body)).not.toMatch(/headersEnc|v1\.a/);
  });
  it('integrations: only genuine Slack webhook URLs; credentials encrypted; list never returns them', async () => {
    asRole('ADMIN'); prismaMock.auditLog.create.mockResolvedValue({}); prismaMock.integration.upsert.mockResolvedValue({});
    expect((await request(app).put('/api/v1/orgs/O/integrations/slack').set(bearer()).send({ config: { webhookUrl: 'https://evil.example.com/services/x' } })).status).toBe(400);
    expect((await request(app).put('/api/v1/orgs/O/integrations/teams').set(bearer()).send({ config: {} })).status).toBe(400);
    const url = 'https://hooks.slack.com/services/T000/B000/XXXX';
    expect((await request(app).put('/api/v1/orgs/O/integrations/slack').set(bearer()).send({ config: { webhookUrl: url } })).status).toBe(200);
    expect(JSON.stringify(prismaMock.integration.upsert.mock.calls[0][0])).not.toContain('XXXX');
    prismaMock.integration.findMany.mockResolvedValue([{ provider: 'slack', enabled: true }]); await request(app).get('/api/v1/orgs/O/integrations').set(bearer());
    expect(prismaMock.integration.findMany.mock.calls[0][0].select.credentialsEnc).toBeUndefined();
    asRole('ANALYST'); expect((await request(app).get('/api/v1/orgs/O/integrations').set(bearer())).status).toBe(403);
  });
  it('recordings: tenant-scoped, audited, never cached', async () => {
    asRole('ANALYST'); prismaMock.auditLog.create.mockResolvedValue({}); prismaMock.recording.findFirst.mockResolvedValue(null);
    expect((await request(app).get('/api/v1/orgs/O/recordings/c1').set(bearer())).status).toBe(404);
    prismaMock.recording.findFirst.mockResolvedValue({ storageKey: 'orgs/O/recordings/c1', contentType: 'audio/wav' });
    const r = await request(app).get('/api/v1/orgs/O/recordings/c1').set(bearer()); expect(r.status).toBe(200); expect(r.headers['cache-control']).toBe('private, no-store'); expect(prismaMock.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'recording.access' }) });
    expect(prismaMock.recording.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ callId: 'c1', orgId: 'O' }) });
    asRole('VIEWER'); // viewers lack recordings:read
    expect((await request(app).get('/api/v1/orgs/O/recordings/c1').set(bearer())).status).toBe(403);
  });
});

describe('users: invitations, roles, export, deletion', () => {
  it('invitation can only be accepted by the invited email', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u2', email: 'other@x.co' }); prismaMock.invitation.findUnique.mockResolvedValue({ id: 'i', orgId: 'O', email: 'invitee@x.co', role: 'VIEWER', acceptedAt: null, expiresAt: new Date(Date.now() + 1e6) });
    expect((await request(app).post('/api/v1/orgs/invitations/accept').set(bearer('u2')).send({ token: 't'.repeat(30) })).status).toBe(400);
    expect(prismaMock.invitation.findUnique).toHaveBeenCalledWith({ where: { tokenHash: sha256('t'.repeat(30)) } });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u2', email: 'Invitee@x.co' }); prismaMock.membership.upsert.mockResolvedValue({}); prismaMock.invitation.update.mockResolvedValue({});
    const ok = await request(app).post('/api/v1/orgs/invitations/accept').set(bearer('u2')).send({ token: 't'.repeat(30) }); expect(ok.status).toBe(200); expect(ok.body.data.orgId).toBe('O');
  });
  it('admin cannot grant or touch OWNER; last owner cannot be demoted', async () => {
    asRole('ADMIN'); prismaMock.membership.findUnique.mockImplementation(async ({ where }) => (where.userId_orgId.userId === 'u1' ? { role: 'ADMIN', org: { deletedAt: null, suspendedAt: null } } : { id: 'm2', role: 'DEVELOPER' }));
    expect((await request(app).patch('/api/v1/orgs/O/members/u9').set(bearer()).send({ role: 'OWNER' })).status).toBe(403);
    asRole('OWNER'); prismaMock.membership.findUnique.mockImplementation(async ({ where }) => (where.userId_orgId.userId === 'u1' ? { role: 'OWNER', org: { deletedAt: null, suspendedAt: null } } : { id: 'm2', role: 'OWNER' })); prismaMock.membership.count.mockResolvedValue(0);
    expect((await request(app).patch('/api/v1/orgs/O/members/u9').set(bearer()).send({ role: 'VIEWER' })).status).toBe(409);
  });
  it('account export returns only the caller\'s data as an attachment', async () => { prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.co' }); prismaMock.membership.findMany.mockResolvedValue([]); prismaMock.session.findMany.mockResolvedValue([]); const r = await request(app).get('/api/v1/users/me/export').set(bearer()); expect(r.status).toBe(200); expect(r.headers['content-disposition']).toMatch(/attachment/); expect(JSON.stringify(r.body)).not.toMatch(/passwordHash/); });
  it('account deletion: needs the password; refuses to orphan an org; otherwise anonymizes + revokes sessions', async () => {
    const passwordHash = await hashPassword('correct-password');
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.co', passwordHash });
    expect((await request(app).post('/api/v1/users/me/delete').set(bearer()).send({ password: 'wrong' })).status).toBe(401);
    prismaMock.membership.findMany.mockResolvedValue([{ orgId: 'O' }]); prismaMock.membership.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    expect((await request(app).post('/api/v1/users/me/delete').set(bearer()).send({ password: 'correct-password' })).status).toBe(409);
    prismaMock.membership.count.mockResolvedValue(0); prismaMock.user.update.mockResolvedValue({}); prismaMock.session.updateMany.mockResolvedValue({});
    expect((await request(app).post('/api/v1/users/me/delete').set(bearer()).send({ password: 'correct-password' })).status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: expect.objectContaining({ email: 'deleted+u1@invalid.local', name: null }) });
  });
  it('email verification for ADMIN_BOOTSTRAP_EMAIL grants platform admin only after verification', async () => {
    vi.stubEnv('ADMIN_BOOTSTRAP_EMAIL', 'root@x.co'); vi.resetModules();
    const { authService } = await import('../../saas-platform/auth/auth.service.js');
    prismaMock.authToken.findUnique.mockResolvedValue({ id: 't', userId: 'u1', type: 'EMAIL_VERIFY', usedAt: null, expiresAt: new Date(Date.now() + 1e6) }); prismaMock.authToken.updateMany.mockResolvedValue({ count: 1 }); prismaMock.user.update.mockResolvedValue({});
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', email: 'root@x.co' });
    await authService.verifyEmail({ token: 'x'.repeat(30) });
    expect(prismaMock.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { isPlatformAdmin: true } }); vi.unstubAllEnvs();
  });
});
