import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../../app.js';
import { prismaMock, resetPrismaMock, rawExec } from '../fixtures/prisma-mock.js';
import { setVoiceProviderForTests } from '../../ai-platform/voice-engine/provider.factory.js';
import { enqueue } from '../../platform-services/background-jobs/queues.js';
import { authService } from '../../saas-platform/auth/auth.service.js';
import { recordUsage } from '../../saas-platform/usage-metering/usage.service.js';
import { getEntitlements, assertCanStartCall } from '../../saas-platform/entitlements/entitlements.service.js';
import { callsService } from '../../ai-platform/calls/calls.service.js';
import { billingService } from '../../saas-platform/billing/billing.service.js';
import { retrieve } from '../../ai-platform/rag/rag.service.js';
import { executeTool } from '../../ai-platform/tool-calling/tool-executor.js';
import { reprocessPendingInbox } from '../../workers/maintenance.js';
import { sha256 } from '../../core/security/crypto.js';

const app = createApp();
beforeEach(() => { resetPrismaMock(); vi.mocked(enqueue).mockClear(); });

describe('auth: refresh-token rotation', () => {
  const live = { id: 's1', userId: 'u1', familyId: 'f1', revokedAt: null, rotatedAt: null, expiresAt: new Date(Date.now() + 1e6) };
  it('rotates a valid token and issues a new one in the same family', async () => {
    prismaMock.session.findUnique.mockResolvedValue(live); prismaMock.session.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1' }); prismaMock.session.create.mockResolvedValue({});
    const t = await authService.refresh({ refreshToken: 'x'.repeat(40) });
    expect(t.refreshToken).toBeTruthy();
    expect(prismaMock.session.create).toHaveBeenCalledWith({ data: expect.objectContaining({ familyId: 'f1', tokenHash: sha256(t.refreshToken) }) });
  });
  it('reuse of a rotated token revokes the entire family', async () => {
    prismaMock.session.findUnique.mockResolvedValue({ ...live, rotatedAt: new Date() }); prismaMock.session.updateMany.mockResolvedValue({ count: 2 });
    await expect(authService.refresh({ refreshToken: 'x'.repeat(40) })).rejects.toMatchObject({ statusCode: 401 });
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { familyId: 'f1', revokedAt: null } }));
  });
  it('concurrent rotation race (count 0) also revokes the family', async () => {
    prismaMock.session.findUnique.mockResolvedValue(live); prismaMock.session.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
    await expect(authService.refresh({ refreshToken: 'x'.repeat(40) })).rejects.toMatchObject({ statusCode: 401 });
  });
  it('rejects expired sessions', async () => {
    prismaMock.session.findUnique.mockResolvedValue({ ...live, expiresAt: new Date(Date.now() - 1) });
    await expect(authService.refresh({ refreshToken: 'x'.repeat(40) })).rejects.toMatchObject({ statusCode: 401 });
  });
  it('login does not reveal whether the email exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(authService.login({ email: 'no@x.co', password: 'whatever12345' })).rejects.toMatchObject({ message: 'Invalid email or password' });
  });
  it('forgot-password is silent for unknown emails', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(authService.forgotPassword({ email: 'no@x.co' })).resolves.toBeUndefined();
    expect(prismaMock.authToken.create).not.toHaveBeenCalled();
  });
  it('reset password invalidates all sessions and rejects reused tokens', async () => {
    prismaMock.authToken.findUnique.mockResolvedValue({ id: 't', userId: 'u1', type: 'PASSWORD_RESET', usedAt: null, expiresAt: new Date(Date.now() + 1e5) });
    prismaMock.authToken.updateMany.mockResolvedValue({ count: 1 }); prismaMock.user.update.mockResolvedValue({}); prismaMock.session.updateMany.mockResolvedValue({ count: 3 });
    await authService.resetPassword({ token: 't'.repeat(40), password: 'a-new-password-1' });
    expect(prismaMock.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }));
    prismaMock.authToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(authService.resetPassword({ token: 't'.repeat(40), password: 'a-new-password-1' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('usage metering idempotency', () => {
  it('records once and aggregates in the same transaction', async () => {
    prismaMock.usageEvent.create.mockResolvedValue({}); rawExec.mockClear();
    expect(await recordUsage({ orgId: 'o', metric: 'CALL_MINUTES', quantity: 3, idempotencyKey: 'k1' })).toEqual({ recorded: true });
    expect(rawExec).toHaveBeenCalledOnce(); // one atomic INSERT … ON DUPLICATE KEY UPDATE
  });
  it('duplicate key (P2002) is a no-op and does not double count', async () => {
    prismaMock.usageEvent.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    rawExec.mockClear();
    expect(await recordUsage({ orgId: 'o', metric: 'CALL_MINUTES', quantity: 3, idempotencyKey: 'k1' })).toMatchObject({ duplicate: true });
    expect(rawExec).not.toHaveBeenCalled();
  });
  it('other DB errors propagate', async () => {
    prismaMock.usageEvent.create.mockRejectedValue(new Error('boom'));
    await expect(recordUsage({ orgId: 'o', metric: 'CALL_MINUTES', quantity: 1, idempotencyKey: 'k' })).rejects.toThrow('boom');
  });
});

describe('subscription entitlements & quota enforcement', () => {
  const sub = (o = {}) => ({ status: 'ACTIVE', graceEndsAt: null, trialEndsAt: null, plan: { code: 'starter', entitlements: { callMinutes: 300, concurrentCalls: 2, hardCap: false } }, ...o });
  it('no subscription ⇒ inactive', async () => { prismaMock.subscription.findFirst.mockResolvedValue(null); expect((await getEntitlements('o')).active).toBe(false); });
  it('active subscription grants plan limits', async () => { prismaMock.subscription.findFirst.mockResolvedValue(sub()); expect(await getEntitlements('o')).toMatchObject({ active: true, planCode: 'starter' }); });
  it('past-due within grace keeps access; after grace it is blocked', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(sub({ status: 'PAST_DUE', graceEndsAt: new Date(Date.now() + 1e6) }));
    expect((await getEntitlements('o')).active).toBe(true);
    prismaMock.subscription.findFirst.mockResolvedValue(sub({ status: 'PAST_DUE', graceEndsAt: new Date(Date.now() - 1e3) }));
    expect(await getEntitlements('o')).toMatchObject({ active: false, reason: 'PAYMENT_FAILED' });
  });
  it('expired trial is blocked', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(sub({ status: 'TRIALING', trialEndsAt: new Date(Date.now() - 1) }));
    expect((await getEntitlements('o')).reason).toBe('TRIAL_ENDED');
  });
  it('blocks calls with 402 when there is no subscription', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(null);
    await expect(assertCanStartCall('o')).rejects.toMatchObject({ statusCode: 402 });
  });
  it('enforces concurrency limit with 429', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(sub()); prismaMock.call.count.mockResolvedValue(2);
    await expect(assertCanStartCall('o')).rejects.toMatchObject({ statusCode: 429, code: 'CONCURRENCY_LIMIT' });
  });
  it('hard-capped trial blocks once included minutes are used', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(sub({ plan: { code: 'trial', entitlements: { callMinutes: 30, concurrentCalls: 1, hardCap: true } } }));
    prismaMock.call.count.mockResolvedValue(0); prismaMock.usageAggregate.findUnique.mockResolvedValue({ quantity: 30n });
    await expect(assertCanStartCall('o')).rejects.toMatchObject({ code: 'USAGE_CAP_REACHED' });
  });
  it('soft-capped plans allow overage', async () => {
    prismaMock.subscription.findFirst.mockResolvedValue(sub()); prismaMock.call.count.mockResolvedValue(0); prismaMock.usageAggregate.findUnique.mockResolvedValue({ quantity: 999n });
    await expect(assertCanStartCall('o')).resolves.toBeTruthy();
  });
});

describe('call lifecycle + provider webhook', () => {
  beforeEach(() => { prismaMock.usageReservation.updateMany.mockResolvedValue({ count: 0 }); prismaMock.usageAggregate.findUnique.mockResolvedValue(null); prismaMock.usageAggregate.create.mockResolvedValue({}); });
  const evt = { message: { type: 'end-of-call-report', durationSeconds: 125, cost: 0.5, endedReason: 'hangup', call: { id: 'pc1' }, artifact: { messages: [{ role: 'user', message: 'hello' }, { role: 'bot', message: 'hi' }] } } };
  const H = { 'x-vapi-secret': 'vapi-test-secret' };
  it('rejects bad signature with 401 and persists nothing', async () => {
    const r = await request(app).post('/api/v1/webhooks/vapi').set('x-vapi-secret', 'wrong').send(evt);
    expect(r.status).toBe(401); expect(prismaMock.webhookEvent.create).not.toHaveBeenCalled();
  });
  it('persists the event before processing, finalizes the call, bills ceil(minutes), enqueues post-call', async () => {
    const order = [];
    prismaMock.webhookEvent.create.mockImplementation(async () => { order.push('persist'); return { id: 'w1' }; });
    prismaMock.webhookEvent.update.mockResolvedValue({});
    prismaMock.call.findUnique.mockImplementation(async () => { order.push('process'); return { id: 'c1', orgId: 'o1', status: 'IN_PROGRESS' }; });
    prismaMock.callEvent.create.mockResolvedValue({}); prismaMock.call.update.mockResolvedValue({}); prismaMock.transcriptSegment.deleteMany.mockResolvedValue({}); prismaMock.transcriptSegment.createMany.mockResolvedValue({});
    prismaMock.usageEvent.create.mockResolvedValue({}); prismaMock.usageAggregate.upsert.mockResolvedValue({});
    const r = await request(app).post('/api/v1/webhooks/vapi').set(H).send(evt);
    expect(r.status).toBe(200); expect(order[0]).toBe('persist');
    const minutes = prismaMock.usageEvent.create.mock.calls.find((c) => c[0].data.metric === 'CALL_MINUTES')[0].data;
    expect(minutes).toMatchObject({ quantity: 3n, idempotencyKey: 'call:c1:minutes' }); // 125s ⇒ 3 min
    expect(prismaMock.usageEvent.create.mock.calls.find((c) => c[0].data.metric === 'PROVIDER_COST')[0].data.costMinor).toBe(50);
    expect(enqueue).toHaveBeenCalledWith('post-call', { callId: 'c1' }, expect.objectContaining({ jobId: 'postcall-c1' }));
  });
  it('duplicate delivery is acknowledged with NO side effects', async () => {
    prismaMock.webhookEvent.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    prismaMock.webhookEvent.findUnique.mockResolvedValue({ id: 'w1', processedAt: new Date() });
    const r = await request(app).post('/api/v1/webhooks/vapi').set(H).send(evt);
    expect(r.status).toBe(200); expect(prismaMock.call.findUnique).not.toHaveBeenCalled(); expect(prismaMock.usageEvent.create).not.toHaveBeenCalled();
  });
  it('failed processing returns 500 so the provider retries, and records the error', async () => {
    prismaMock.webhookEvent.create.mockResolvedValue({ id: 'w2' }); prismaMock.webhookEvent.update.mockResolvedValue({});
    prismaMock.call.findUnique.mockRejectedValue(new Error('db down'));
    const r = await request(app).post('/api/v1/webhooks/vapi').set(H).send(evt);
    expect(r.status).toBe(500); expect(r.body.error.message).not.toMatch(/db down/);
    expect(prismaMock.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: { error: 'db down' } }));
  });
  it('a finished call is never regressed by a late status event', async () => {
    prismaMock.call.findUnique.mockResolvedValue({ id: 'c1', orgId: 'o', status: 'COMPLETED' }); prismaMock.callEvent.create.mockResolvedValue({});
    await callsService.applyProviderEvent({ providerCallId: 'pc1', type: 'status-update', status: 'IN_PROGRESS', data: {} });
    expect(prismaMock.call.update).not.toHaveBeenCalled();
  });
  it('outbound start: provider failure marks call FAILED and surfaces the error', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({ id: 'a', providerAssistantId: 'as1', currentVersionId: 'v' });
    prismaMock.phoneNumber.findFirst.mockResolvedValue({ providerNumberId: 'pn', e164: '+15550001111' });
    prismaMock.subscription.findFirst.mockResolvedValue({ status: 'ACTIVE', plan: { code: 'x', entitlements: { concurrentCalls: 5, hardCap: false, callMinutes: 10 } } });
    prismaMock.call.count.mockResolvedValue(0); prismaMock.call.create.mockResolvedValue({ id: 'c9' }); prismaMock.call.update.mockResolvedValue({}); prismaMock.callEvent.create.mockResolvedValue({});
    setVoiceProviderForTests({ startOutboundCall: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'PROVIDER_UNAVAILABLE' })), createAssistant() {}, updateAssistant() {}, deleteAssistant() {}, endCall() {}, getCall() {}, parseWebhook() {}, verifyWebhook() {} });
    await expect(callsService.startOutbound('o', { agentId: 'a', phoneNumberId: 'p', toNumber: '+15551234567' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(prismaMock.call.update).toHaveBeenCalledWith({ where: { id: 'c9' }, data: expect.objectContaining({ status: 'FAILED' }) });
    setVoiceProviderForTests(undefined);
  });
});

describe('billing webhook (Stripe) signature + idempotency', () => {
  const event = { id: 'evt_1', object: 'event', type: 'invoice.payment_failed', data: { object: { id: 'in_1', customer: 'cus_1', currency: 'usd', total: 4900 } } };
  const signed = (payload) => ({ body: payload, sig: Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' }) });
  it('rejects missing/invalid signatures with 400', async () => {
    const p = JSON.stringify(event);
    expect((await request(app).post('/api/v1/webhooks/stripe').set('content-type', 'application/json').send(p)).status).toBe(400);
    expect((await request(app).post('/api/v1/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', 't=1,v1=bad').send(p)).status).toBe(400);
    expect(prismaMock.webhookEvent.create).not.toHaveBeenCalled();
  });
  it('rejects a tampered body even with a once-valid signature', async () => {
    const { sig } = signed(JSON.stringify(event));
    const r = await request(app).post('/api/v1/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(JSON.stringify({ ...event, id: 'evt_evil' }));
    expect(r.status).toBe(400);
  });
  it('processes a validly signed event once; a replay is a no-op', async () => {
    const { body, sig } = signed(JSON.stringify(event));
    prismaMock.webhookEvent.create.mockResolvedValueOnce({ id: 'w' }); prismaMock.webhookEvent.update.mockResolvedValue({});
    prismaMock.billingCustomer.findUnique.mockResolvedValue({ orgId: 'o1' }); prismaMock.invoice.upsert.mockResolvedValue({}); prismaMock.subscription.updateMany.mockResolvedValue({ count: 1 });
    const r1 = await request(app).post('/api/v1/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(body);
    expect(r1.status).toBe(200);
    expect(prismaMock.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PAST_DUE', graceEndsAt: expect.any(Date) }) }));
    prismaMock.subscription.updateMany.mockClear();
    prismaMock.webhookEvent.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' })); prismaMock.webhookEvent.findUnique.mockResolvedValue({ id: 'w', processedAt: new Date() });
    const r2 = await request(app).post('/api/v1/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(body);
    expect(r2.status).toBe(200); expect(prismaMock.subscription.updateMany).not.toHaveBeenCalled();
  });
  it('subscription lifecycle: created → active; deleted → canceled', async () => {
    prismaMock.billingCustomer.findUnique.mockResolvedValue({ orgId: 'o1' }); prismaMock.planPrice.findFirst.mockResolvedValue({ planId: 'p1', interval: 'MONTH' }); prismaMock.subscription.upsert.mockResolvedValue({});
    const sub = { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ price: { id: 'price_1' }, current_period_start: 1700000000, current_period_end: 1702592000 }] } };
    await billingService.handleStripeEvent({ type: 'customer.subscription.created', data: { object: sub } });
    expect(prismaMock.subscription.upsert.mock.calls[0][0].create).toMatchObject({ status: 'ACTIVE', orgId: 'o1', providerSubscriptionId: 'sub_1' });
    await billingService.handleStripeEvent({ type: 'customer.subscription.deleted', data: { object: sub } });
    expect(prismaMock.subscription.upsert.mock.calls[1][0].update.status).toBe('CANCELED');
  });
  it('unknown customer throws so Stripe retries (no silent loss)', async () => {
    prismaMock.billingCustomer.findUnique.mockResolvedValue(null);
    await expect(billingService.handleStripeEvent({ type: 'customer.subscription.updated', data: { object: { id: 's', customer: 'cus_x', items: { data: [] } } } })).rejects.toThrow(/Unknown billing customer/);
  });
  it('checkout never trusts client prices: unknown plan ⇒ 404', async () => {
    prismaMock.planPrice.findFirst.mockResolvedValue(null);
    await expect(billingService.createCheckout('o', 'a@b.co', { planCode: 'free-enterprise', interval: 'MONTH' })).rejects.toMatchObject({ statusCode: 404 });
  });
  it('reconciliation re-processes stored-but-unprocessed events', async () => {
    prismaMock.webhookEvent.findMany.mockResolvedValue([{ id: 'w9', source: 'stripe', payload: { ...event, id: 'evt_9' }, receivedAt: new Date(0) }]);
    prismaMock.billingCustomer.findUnique.mockResolvedValue({ orgId: 'o1' }); prismaMock.invoice.upsert.mockResolvedValue({}); prismaMock.subscription.updateMany.mockResolvedValue({}); prismaMock.webhookEvent.update.mockResolvedValue({});
    await reprocessPendingInbox();
    expect(prismaMock.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'w9' }, data: expect.objectContaining({ processedAt: expect.any(Date) }) }));
  });
});

describe('RAG tenant isolation', () => {
  it('returns no-answer when the agent has no knowledge bases (and never calls the vector store)', async () => {
    prismaMock.agentKnowledgeBase.findMany.mockResolvedValue([]);
    expect(await retrieve({ orgId: 'o', agentId: 'a', query: 'q' })).toMatchObject({ answerable: false, reason: 'NO_KNOWLEDGE_BASE' });
  });
  it('KB links are joined through the org so foreign KBs are dropped', async () => {
    prismaMock.agentKnowledgeBase.findMany.mockResolvedValue([]);
    await retrieve({ orgId: 'orgA', agentId: 'a', query: 'q' });
    expect(prismaMock.agentKnowledgeBase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { agentId: 'a', kb: { orgId: 'orgA' } } }));
  });
  it('Qdrant search always filters by orgId + agent KBs, and applies threshold / no-answer', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { total_tokens: 5 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: [{ score: 0.1, payload: { text: 'weak', documentId: 'd', filename: 'f', ordinal: 0 } }] }) });
    vi.stubGlobal('fetch', f);
    vi.stubEnv('EMBEDDING_BASE_URL', 'https://emb.test/v1'); vi.stubEnv('EMBEDDING_API_KEY', 'k'); vi.stubEnv('QDRANT_URL', 'https://qd.test');
    vi.resetModules(); // env is parsed at import time, so re-import with providers configured
    prismaMock.agentKnowledgeBase.findMany.mockResolvedValue([{ knowledgeBaseId: 'kb1' }]);
    const { retrieve: r2 } = await import('../../ai-platform/rag/rag.service.js');
    const res = await r2({ orgId: 'orgA', agentId: 'a', query: 'q', threshold: 0.35 });
    const searchBody = JSON.parse(f.mock.calls[1][1].body);
    expect(searchBody.filter.must).toEqual(expect.arrayContaining([{ key: 'orgId', match: { value: 'orgA' } }, { key: 'knowledgeBaseId', match: { any: ['kb1'] } }]));
    expect(res.answerable).toBe(false); // 0.1 < threshold ⇒ explicit no-answer
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
});

describe('secure tool execution', () => {
  const tool = { id: 't1', kind: 'order_lookup', config: { url: 'https://api.shop.test/orders' } };
  it('denies tools not attached to the agent in this org (403)', async () => {
    prismaMock.toolDefinition.findFirst.mockResolvedValue(null);
    await expect(executeTool({ orgId: 'o', agentId: 'a', toolName: 'order_lookup', rawArgs: { orderId: '1' } })).rejects.toMatchObject({ statusCode: 403, code: 'TOOL_DENIED' });
    expect(prismaMock.toolDefinition.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({ orgId: 'o', enabled: true, agents: { some: { agentId: 'a', agent: { orgId: 'o' } } } }) });
  });
  it('rejects invalid/smuggled arguments, logs DENIED and never calls out', async () => {
    prismaMock.toolDefinition.findFirst.mockResolvedValue(tool); prismaMock.toolExecution.create.mockResolvedValue({});
    await expect(executeTool({ orgId: 'o', agentId: 'a', toolName: 'order_lookup', rawArgs: { orderId: '1', url: 'http://169.254.169.254' } })).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.toolExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'DENIED' }) });
  });
  it('blocks tools whose stored URL resolves to a private/loopback host (SSRF) without retry storms', async () => {
    prismaMock.toolDefinition.findFirst.mockResolvedValue({ ...tool, config: { url: 'https://127.0.0.1/orders' } }); prismaMock.toolExecution.create.mockResolvedValue({});
    await expect(executeTool({ orgId: 'o', agentId: 'a', toolName: 'order_lookup', rawArgs: { orderId: '1' } })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(prismaMock.toolExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'FAILED' }) });
  });
  it('never retries non-idempotent writes', async () => {
    prismaMock.toolDefinition.findFirst.mockResolvedValue({ id: 't2', kind: 'lead_create', config: { url: 'https://127.0.0.1/leads' } }); prismaMock.toolExecution.create.mockResolvedValue({});
    await expect(executeTool({ orgId: 'o', agentId: 'a', toolName: 'lead_create', rawArgs: { name: 'Ann' } })).rejects.toBeTruthy();
    expect(prismaMock.toolExecution.create).toHaveBeenCalledTimes(1);
  });
});
