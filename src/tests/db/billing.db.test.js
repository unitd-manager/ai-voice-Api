import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { realPrisma as prisma } from './db-client.js';
import { resetDb, makeOrg, makeUser } from './helpers.js';
import { fakeRedis } from '../fixtures/fake-redis.js';

vi.mock('../../core/security/ssrf.js', async (orig) => ({ ...(await orig()), safeFetch: vi.fn() }));
const stripeMock = { invoiceItems: { create: vi.fn() } };
vi.mock('../../saas-platform/payments/stripe.client.js', () => ({ getStripe: () => stripeMock }));

const { recordUsage, recordGauge, getPeriodUsage } = await import('../../saas-platform/usage-metering/usage.service.js');
const { grantCredits, consumeUpTo, getBalance } = await import('../../saas-platform/credits/credits.service.js');
const { reserve, settleReservation, expireReservations } = await import('../../saas-platform/usage-metering/reservations.service.js');
const { receiveWebhook } = await import('../../platform-services/webhooks/webhook-inbox.js');
const { callsService } = await import('../../ai-platform/calls/calls.service.js');
const { setVoiceProviderForTests } = await import('../../ai-platform/voice-engine/provider.factory.js');
const { createVapiAdapter } = await import('../../ai-platform/voice-engine/vapi.adapter.js');
const { billOverage } = await import('../../saas-platform/billing/billing.service.js');
const { checkUsageAlerts } = await import('../../saas-platform/usage-metering/alerts.service.js');
const { getEntitlements, assertCanStartCall } = await import('../../saas-platform/entitlements/entitlements.service.js');
const { remember, getMemory, purgeExpiredMemory } = await import('../../ai-platform/conversation-engine/memory.service.js');
const { executeTool } = await import('../../ai-platform/tool-calling/tool-executor.js');
const { safeFetch } = await import('../../core/security/ssrf.js');
const { snapshotStorage, recordPhoneCharges, enforceRetention, reprocessPendingInbox } = await import('../../workers/maintenance.js');
const { enqueue } = await import('../../platform-services/background-jobs/queues.js');
const { setTransportForTests } = await import('../../platform-services/email/email.service.js');

beforeAll(async () => { await resetDb(); });
beforeEach(() => { fakeRedis._reset(); vi.clearAllMocks(); setVoiceProviderForTests(undefined); setTransportForTests({ sendMail: async () => {} }); });
const par = (n, fn) => Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));

describe('usage metering (real constraints)', () => {
  it('10 concurrent writes of the SAME idempotency key count exactly once', async () => {
    const o = await makeOrg(); const key = `k-${o.id}`;
    const r = await par(10, () => recordUsage({ orgId: o.id, metric: 'CALL_MINUTES', quantity: 7, idempotencyKey: key }));
    expect(r.filter((x) => x.status === 'fulfilled' && x.value.recorded).length).toBe(1);
    expect(await prisma.usageEvent.count({ where: { orgId: o.id } })).toBe(1); expect(await getPeriodUsage(o.id, 'CALL_MINUTES')).toBe(7);
  });
  it('distinct keys accumulate correctly under concurrency (no lost updates)', async () => {
    const o = await makeOrg(); await par(20, (i) => recordUsage({ orgId: o.id, metric: 'CALL_MINUTES', quantity: 3, idempotencyKey: `u${i}` }));
    expect(await getPeriodUsage(o.id, 'CALL_MINUTES')).toBe(60);
  });
  it('tenants are metered independently (same key in two orgs is fine)', async () => {
    const a = await makeOrg(), b = await makeOrg();
    await recordUsage({ orgId: a.id, metric: 'LLM_TOKENS', quantity: 5, idempotencyKey: 'same' }); await recordUsage({ orgId: b.id, metric: 'LLM_TOKENS', quantity: 9, idempotencyKey: 'same' });
    expect(await getPeriodUsage(a.id, 'LLM_TOKENS')).toBe(5); expect(await getPeriodUsage(b.id, 'LLM_TOKENS')).toBe(9);
  });
  it('gauges: "max" never decreases, "set" overwrites', async () => {
    const o = await makeOrg();
    await recordGauge({ orgId: o.id, metric: 'CONCURRENT_CALLS', value: 3, mode: 'max' }); await recordGauge({ orgId: o.id, metric: 'CONCURRENT_CALLS', value: 2, mode: 'max' }); expect(await getPeriodUsage(o.id, 'CONCURRENT_CALLS')).toBe(3);
    await recordGauge({ orgId: o.id, metric: 'STORAGE_BYTES', value: 100, mode: 'set' }); await recordGauge({ orgId: o.id, metric: 'STORAGE_BYTES', value: 40, mode: 'set' }); expect(await getPeriodUsage(o.id, 'STORAGE_BYTES')).toBe(40);
  });
});

describe('credits (real transactions)', () => {
  it('grant is idempotent; concurrent consumption never overdrafts and the ledger matches the balance', async () => {
    const o = await makeOrg();
    await par(3, () => grantCredits({ orgId: o.id, amountMinor: 500, reason: 'p', idempotencyKey: `grant-${o.id}` }));
    expect((await getBalance(o.id)).balanceMinor).toBe(500);
    const rs = await par(12, (i) => consumeUpTo({ orgId: o.id, maxMinor: 100, reason: 'use', idempotencyKey: `use-${o.id}-${i}` }));
    const consumed = rs.filter((r) => r.status === 'fulfilled').reduce((s, r) => s + r.value.consumedMinor, 0);
    const bal = (await getBalance(o.id)).balanceMinor;
    expect(bal).toBeGreaterThanOrEqual(0); expect(consumed + bal).toBe(500); expect(consumed).toBeLessThanOrEqual(500);
    const acct = await prisma.creditAccount.findUnique({ where: { orgId: o.id } }); const sum = await prisma.creditTransaction.aggregate({ where: { accountId: acct.id }, _sum: { deltaMinor: true } });
    expect(sum._sum.deltaMinor).toBe(bal);
  });
  it('replaying a consume key returns the originally consumed amount', async () => {
    const o = await makeOrg(); await grantCredits({ orgId: o.id, amountMinor: 300, reason: 'p', idempotencyKey: `g-${o.id}` });
    const first = await consumeUpTo({ orgId: o.id, maxMinor: 200, reason: 'r', idempotencyKey: `c-${o.id}` });
    const again = await consumeUpTo({ orgId: o.id, maxMinor: 200, reason: 'r', idempotencyKey: `c-${o.id}` });
    expect(first.consumedMinor).toBe(200); expect(again).toMatchObject({ consumedMinor: 200, duplicate: true }); expect((await getBalance(o.id)).balanceMinor).toBe(100);
  });
});

describe('usage reservations (row-lock serialization)', () => {
  it('5 parallel reservations of 10 against a cap of 30 ⇒ exactly 3 succeed', async () => {
    const o = await makeOrg();
    const r = await par(5, (i) => reserve({ orgId: o.id, quantity: 10, limit: 30, callId: `c${i}` }));
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(3);
    expect(r.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'USAGE_CAP_REACHED')).toBe(true);
  });
  it('released/expired reservations free capacity; committed ones stay held via usage', async () => {
    const o = await makeOrg(); await reserve({ orgId: o.id, quantity: 30, limit: 30, callId: 'a' });
    await expect(reserve({ orgId: o.id, quantity: 1, limit: 30, callId: 'b' })).rejects.toMatchObject({ code: 'USAGE_CAP_REACHED' });
    await settleReservation('a', 'RELEASED'); await reserve({ orgId: o.id, quantity: 30, limit: 30, callId: 'c' });
    await prisma.usageReservation.updateMany({ where: { callId: 'c' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await expireReservations()).count).toBe(1); await reserve({ orgId: o.id, quantity: 30, limit: 30, callId: 'd' });
  });
});

describe('webhook inbox (real unique index + atomic claim)', () => {
  it('sequential duplicate runs the handler once', async () => {
    const fn = vi.fn(); const ev = { source: 'vapi', externalId: `e-${Date.now()}`, type: 't', payload: { a: 1 } };
    expect((await receiveWebhook(ev, fn)).duplicate).toBe(false); expect((await receiveWebhook(ev, fn)).duplicate).toBe(true); expect(fn).toHaveBeenCalledTimes(1);
  });
  it('8 concurrent deliveries of one event ⇒ handler runs exactly once', async () => {
    const fn = vi.fn(async () => { await new Promise((r) => setTimeout(r, 150)); }); const ev = { source: 'stripe', externalId: `c-${Date.now()}`, type: 't', payload: {} };
    await par(8, () => receiveWebhook(ev, fn)); expect(fn).toHaveBeenCalledTimes(1);
    expect((await prisma.webhookEvent.findUnique({ where: { source_externalId: { source: 'stripe', externalId: ev.externalId } } })).processedAt).toBeTruthy();
  });
  it('failed handler leaves the event unprocessed (recorded error) and the sweep can finish it', async () => {
    const ev = { source: 'vapi', externalId: `f-${Date.now()}`, type: 'x', payload: { message: { type: 'status-update', call: { id: 'pc-none' } } } };
    await expect(receiveWebhook(ev, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let row = await prisma.webhookEvent.findUnique({ where: { source_externalId: { source: 'vapi', externalId: ev.externalId } } }); expect(row).toMatchObject({ processedAt: null, error: 'boom' });
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { receivedAt: new Date(Date.now() - 10 * 60e3) } });
    await reprocessPendingInbox(); row = await prisma.webhookEvent.findUnique({ where: { id: row.id } }); expect(row.processedAt).toBeTruthy();
  });
});

describe('call lifecycle + billing on a real database', () => {
  async function setup(planEnt) {
    const org = planEnt ? await (async () => { const code = `plan-${Math.random().toString(36).slice(2)}`; const plan = await prisma.plan.create({ data: { code, name: code, entitlements: planEnt } }); const o = await prisma.organization.create({ data: { name: 'o', slug: code } }); await prisma.subscription.create({ data: { orgId: o.id, planId: plan.id, status: 'ACTIVE', interval: 'MONTH', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 864e6) } }); return o; })() : await makeOrg('growth');
    const agent = await prisma.agent.create({ data: { orgId: org.id, name: 'A', status: 'PUBLISHED', providerAssistantId: 'as1' } });
    const v = await prisma.agentVersion.create({ data: { agentId: agent.id, version: 1, config: { systemPrompt: 's', maxCallDurationSeconds: 600 } } });
    await prisma.agent.update({ where: { id: agent.id }, data: { currentVersionId: v.id } });
    const phone = await prisma.phoneNumber.create({ data: { orgId: org.id, agentId: agent.id, e164: `+1415${Math.floor(1000000 + Math.random() * 8999999)}`, providerNumberId: `pn-${org.id}` } });
    return { org, agent, phone };
  }
  const provider = () => { let n = 0; setVoiceProviderForTests(createVapiAdapter({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ id: `pc-${Date.now()}-${++n}` }) }) })); };

  it('end-of-call report: finalizes once, bills ceil(min) once, stores transcript; a replayed report changes nothing', async () => {
    const { org, agent } = await setup();
    const call = await prisma.call.create({ data: { orgId: org.id, agentId: agent.id, direction: 'OUTBOUND', status: 'IN_PROGRESS', providerCallId: 'pc-fin-1' } });
    const evt = createVapiAdapter({}).parseWebhook({ message: { type: 'end-of-call-report', endedReason: 'hangup', durationSeconds: 125, cost: 0.42, summary: 'ok', call: { id: 'pc-fin-1' }, recordingUrl: 'https://cdn.test/r.wav', artifact: { messages: [{ role: 'system', message: 's' }, { role: 'bot', message: 'hi' }, { role: 'user', message: 'hello' }] } } });
    await callsService.applyProviderEvent(evt); await callsService.applyProviderEvent(evt);
    const c = await prisma.call.findUnique({ where: { id: call.id } }); expect(c).toMatchObject({ status: 'COMPLETED', durationSeconds: 125, providerCostMinor: 42, summary: 'ok' });
    expect(await getPeriodUsage(org.id, 'CALL_MINUTES')).toBe(3); expect(await prisma.usageEvent.count({ where: { orgId: org.id, metric: 'PROVIDER_COST' } })).toBe(1);
    expect((await prisma.transcriptSegment.findMany({ where: { callId: call.id }, orderBy: { seq: 'asc' } })).map((s) => [s.speaker, s.text])).toEqual([['agent', 'hi'], ['customer', 'hello']]);
    expect(enqueue).toHaveBeenCalledWith('recording-download', expect.objectContaining({ callId: call.id }), expect.any(Object));
  });
  it('inbound call to our number creates the Call and a status-update does not regress a finished call', async () => {
    const { org, phone } = await setup(); const adapter = createVapiAdapter({});
    await callsService.applyProviderEvent(adapter.parseWebhook({ message: { type: 'status-update', status: 'in-progress', timestamp: 1, call: { id: 'pc-in-1', type: 'inboundPhoneCall', phoneNumberId: phone.providerNumberId, customer: { number: '+14155550100' } } } }));
    const c = await prisma.call.findUnique({ where: { providerCallId: 'pc-in-1' } }); expect(c).toMatchObject({ orgId: org.id, direction: 'INBOUND', fromNumber: '+14155550100', toNumber: phone.e164 });
    await callsService.applyProviderEvent(adapter.parseWebhook({ message: { type: 'end-of-call-report', durationSeconds: 30, call: { id: 'pc-in-1' } } }));
    await callsService.applyProviderEvent(adapter.parseWebhook({ message: { type: 'status-update', status: 'in-progress', timestamp: 9, call: { id: 'pc-in-1' } } }));
    expect((await prisma.call.findUnique({ where: { id: c.id } })).status).toBe('COMPLETED');
  });
  it('hard-capped plan: parallel outbound starts are limited by reservations; failures release the hold', async () => {
    const { org, agent, phone } = await setup({ callMinutes: 25, concurrentCalls: 50, hardCap: true, overageCentsPerMinute: 0 }); provider();
    const r = await par(5, () => callsService.startOutbound(org.id, { agentId: agent.id, phoneNumberId: phone.id, toNumber: '+14155550123' })); // each holds 10 min (600s)
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(2);
    expect(r.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'USAGE_CAP_REACHED')).toBe(true);
    expect(await prisma.usageReservation.count({ where: { orgId: org.id, status: 'HELD' } })).toBe(2);
    expect(await prisma.call.count({ where: { orgId: org.id, status: 'FAILED', endReason: 'usage_cap' } })).toBe(3);
  });
  it('concurrency limit and missing/expired subscription are enforced against real rows', async () => {
    const { org } = await setup({ callMinutes: 100, concurrentCalls: 1, hardCap: false });
    await prisma.call.create({ data: { orgId: org.id, agentId: (await prisma.agent.findFirst({ where: { orgId: org.id } })).id, direction: 'OUTBOUND', status: 'IN_PROGRESS' } });
    await expect(assertCanStartCall(org.id)).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    await prisma.subscription.updateMany({ where: { orgId: org.id }, data: { status: 'PAST_DUE', graceEndsAt: new Date(Date.now() - 1000) } });
    expect((await getEntitlements(org.id)).reason).toBe('PAYMENT_FAILED');
    await prisma.subscription.updateMany({ where: { orgId: org.id }, data: { graceEndsAt: new Date(Date.now() + 1e6) } }); expect((await getEntitlements(org.id)).active).toBe(true);
  });
  it('calls from one tenant are invisible to another in list/get queries', async () => {
    const a = await setup(), b = await setup(); const c = await prisma.call.create({ data: { orgId: a.org.id, agentId: a.agent.id, direction: 'OUTBOUND' } });
    await expect(callsService.get(b.org.id, c.id)).rejects.toMatchObject({ statusCode: 404 }); expect(await callsService.list(b.org.id, { take: 10 })).toEqual([]);
  });
});

describe('overage invoicing from real usage rows', () => {
  const inv = (start, end) => ({ id: `in_${Math.random()}`, customer: 'cus_o', currency: 'usd', status: 'draft', billing_reason: 'subscription_cycle', period_start: Math.floor(start / 1000), period_end: Math.floor(end / 1000) });
  it('sums only usage inside the invoice period, applies credits, bills the remainder', async () => {
    const o = await makeOrg('starter'); // 300 included, 18¢/min overage
    await prisma.billingCustomer.create({ data: { orgId: o.id, providerCustomerId: 'cus_o' } });
    const t0 = Date.now() - 20 * 864e5, t1 = Date.now() + 864e5;
    await recordUsage({ orgId: o.id, metric: 'CALL_MINUTES', quantity: 340, idempotencyKey: 'in-period', occurredAt: new Date(Date.now() - 5 * 864e5) });
    await recordUsage({ orgId: o.id, metric: 'CALL_MINUTES', quantity: 999, idempotencyKey: 'old', occurredAt: new Date(t0 - 864e5) }); // outside the period
    await grantCredits({ orgId: o.id, amountMinor: 200, reason: 'p', idempotencyKey: `g-${o.id}` });
    const i = inv(t0, t1); await billOverage(i); // overage 40 min × 18 = 720; credits 200 ⇒ charge 520
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 520 }), expect.any(Object)); expect((await getBalance(o.id)).balanceMinor).toBe(0);
    stripeMock.invoiceItems.create.mockClear(); await billOverage(i); expect(stripeMock.invoiceItems.create.mock.calls[0][0].amount).toBe(520); // replay: same charge, credits not re-spent
    expect((await prisma.creditAccount.findUnique({ where: { orgId: o.id } })).balanceMinor).toBe(0);
  });
});

describe('alerts, memory, tools, maintenance (real rows)', () => {
  it('usage alerts: one notification per threshold per month even when run concurrently', async () => {
    const o = await makeOrg('starter'); await makeUser(o.id, 'OWNER');
    await recordUsage({ orgId: o.id, metric: 'CALL_MINUTES', quantity: 250, idempotencyKey: `a-${o.id}` }); // 83%
    await par(4, () => checkUsageAlerts(o.id)); expect(await prisma.notification.count({ where: { orgId: o.id, type: 'usage.threshold' } })).toBe(1);
    await recordUsage({ orgId: o.id, metric: 'CALL_MINUTES', quantity: 60, idempotencyKey: `b-${o.id}` }); await par(4, () => checkUsageAlerts(o.id));
    expect(await prisma.notification.count({ where: { orgId: o.id, type: 'usage.threshold' } })).toBe(2);
    await prisma.notification.create({ data: { orgId: o.id, type: 'x', title: 't' } }); await prisma.notification.create({ data: { orgId: o.id, type: 'x', title: 't' } }); // NULL dedupeKey rows may repeat
  });
  it('memory: stored hashed with expiry, merged, purged', async () => {
    const o = await makeOrg(); const a = await prisma.agent.create({ data: { orgId: o.id, name: 'm' } });
    await remember({ orgId: o.id, agentId: a.id, contact: '+14155550100', summary: 'first call', retentionDays: 1 }); await remember({ orgId: o.id, agentId: a.id, contact: '+1 415 555 0100', summary: 'second call', retentionDays: 1 });
    const m = await getMemory(o.id, a.id, '+14155550100'); expect(m).toContain('second call'); expect(m).toContain('first call');
    expect(JSON.stringify(await prisma.conversationMemory.findMany({ where: { orgId: o.id } }))).not.toContain('4155550100');
    await prisma.conversationMemory.updateMany({ where: { orgId: o.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); expect(await getMemory(o.id, a.id, '+14155550100')).toBeNull(); expect((await purgeExpiredMemory()).count).toBeGreaterThanOrEqual(1);
  });
  it('tool execution: allow-list enforced by SQL, success is logged + metered; cross-agent/org use is denied', async () => {
    const o = await makeOrg(), o2 = await makeOrg(); const a = await prisma.agent.create({ data: { orgId: o.id, name: 'a' } }); const other = await prisma.agent.create({ data: { orgId: o.id, name: 'other' } });
    const t = await prisma.toolDefinition.create({ data: { orgId: o.id, name: 'order_lookup', kind: 'order_lookup', description: 'd', paramsSchema: {}, config: { url: 'https://api.shop.test/orders' } } });
    await prisma.agentTool.create({ data: { agentId: a.id, toolId: t.id } });
    safeFetch.mockResolvedValue({ ok: true, status: 200, text: JSON.stringify({ status: 'shipped', email: 'bob@x.com' }) });
    const res = await executeTool({ orgId: o.id, agentId: a.id, toolName: 'order_lookup', rawArgs: { orderId: 'A-1' } }); expect(res.status).toBe('shipped');
    const log = await prisma.toolExecution.findFirst({ where: { orgId: o.id } }); expect(log.status).toBe('SUCCESS'); expect(JSON.stringify(log.result)).not.toContain('bob@x.com');
    expect(await getPeriodUsage(o.id, 'TOOL_EXECUTIONS')).toBe(1);
    await expect(executeTool({ orgId: o.id, agentId: other.id, toolName: 'order_lookup', rawArgs: { orderId: 'A-1' } })).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    await expect(executeTool({ orgId: o2.id, agentId: a.id, toolName: 'order_lookup', rawArgs: { orderId: 'A-1' } })).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });
  it('storage snapshot, phone charges (idempotent per month), retention', async () => {
    const o = await makeOrg(); const kb = await prisma.knowledgeBase.create({ data: { orgId: o.id, name: 'k' } });
    await prisma.knowledgeDocument.create({ data: { orgId: o.id, knowledgeBaseId: kb.id, filename: 'f', mimeType: 'text/plain', sizeBytes: 1000, storageKey: 'k1' } });
    const a = await prisma.agent.create({ data: { orgId: o.id, name: 'a' } }); const call = await prisma.call.create({ data: { orgId: o.id, agentId: a.id, direction: 'OUTBOUND', createdAt: new Date(Date.now() - 400 * 864e5) } });
    await prisma.recording.create({ data: { callId: call.id, orgId: o.id, storageKey: 'orgs/x/r', sizeBytes: 500n, createdAt: new Date(Date.now() - 400 * 864e5) } });
    await prisma.transcriptSegment.create({ data: { callId: call.id, seq: 0, speaker: 'agent', text: 'old' } });
    await snapshotStorage(); expect(await getPeriodUsage(o.id, 'STORAGE_BYTES')).toBe(1500);
    await prisma.phoneNumber.create({ data: { orgId: o.id, e164: `+1415${Math.floor(Math.random() * 9e6 + 1e6)}`, monthlyCostMinor: 200 } }); await recordPhoneCharges(); await recordPhoneCharges();
    expect(await prisma.usageEvent.count({ where: { orgId: o.id, metric: 'PHONE_NUMBER_COST' } })).toBe(1);
    await enforceRetention(); expect((await prisma.recording.findUnique({ where: { callId: call.id } })).deletedAt).toBeTruthy(); expect(await prisma.transcriptSegment.count({ where: { callId: call.id } })).toBe(0);
  });
});
