import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { realPrisma as prisma } from '../db/db-client.js';
import { resetDb, makeOrg, makeUser } from '../db/helpers.js';

// Real Stripe SDK → stripe-mock (Stripe's official OpenAPI-driven mock server, which validates request parameters),
// real signed webhooks, real MySQL. Needs stripe-mock on :12111 (see README).
const { createApp } = await import('../../app.js');
const { signAccessToken } = await import('../../core/security/tokens.js');
const { billOverage, reconcileBilling } = await import('../../saas-platform/billing/billing.service.js');
const { getEntitlements } = await import('../../saas-platform/entitlements/entitlements.service.js');
const { recordUsage } = await import('../../saas-platform/usage-metering/usage.service.js');
const { grantCredits, getBalance } = await import('../../saas-platform/credits/credits.service.js');

const app = createApp();
const bearer = (uid) => ({ Authorization: `Bearer ${signAccessToken(uid)}` });
const post = (path, body, uid) => request(app).post(path).set(bearer(uid)).send(body);
const sign = (event) => { const payload = JSON.stringify(event); return { payload, sig: Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' }) }; };
const hook = (event) => { const { payload, sig } = sign(event); return request(app).post('/api/v1/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(payload); };
let org, user, growth;

beforeAll(async () => {
  await resetDb(); org = await makeOrg('starter'); user = await makeUser(org.id, 'OWNER');
  growth = await prisma.plan.findUnique({ where: { code: 'growth' } });
  await prisma.planPrice.updateMany({ where: { planId: growth.id, interval: 'MONTH' }, data: { providerPriceId: 'price_growth_month' } });
});

describe('Stripe SDK calls validated by stripe-mock', () => {
  it('checkout creates a Stripe customer once, reuses it, and returns a hosted URL; unknown plans are 404', async () => {
    const a = await post(`/api/v1/orgs/${org.id}/billing/checkout`, { planCode: 'growth', interval: 'MONTH' }, user.id); expect(a.status).toBe(200); expect(a.body.data.url).toMatch(/^https?:\/\//);
    const cust = await prisma.billingCustomer.findUnique({ where: { orgId: org.id } }); expect(cust.providerCustomerId).toMatch(/^cus_/);
    await post(`/api/v1/orgs/${org.id}/billing/checkout`, { planCode: 'growth', interval: 'MONTH' }, user.id); expect(await prisma.billingCustomer.count({ where: { orgId: org.id } })).toBe(1);
    expect((await post(`/api/v1/orgs/${org.id}/billing/checkout`, { planCode: 'nope', interval: 'MONTH' }, user.id)).status).toBe(404);
  });
  it('billing portal and credit-pack checkout produce valid Stripe requests; arbitrary amounts are refused', async () => {
    expect((await post(`/api/v1/orgs/${org.id}/billing/portal`, {}, user.id)).body.data.url).toMatch(/^https?:\/\//);
    expect((await post(`/api/v1/orgs/${org.id}/credits/checkout`, { amountMinor: 5000 }, user.id)).body.data.url).toMatch(/^https?:\/\//);
    expect((await post(`/api/v1/orgs/${org.id}/credits/checkout`, { amountMinor: 1 }, user.id)).status).toBe(400);
  });
  it('overage invoice item is a valid Stripe request (credits first, replay-safe)', async () => {
    const cust = await prisma.billingCustomer.findUnique({ where: { orgId: org.id } });
    await recordUsage({ orgId: org.id, metric: 'CALL_MINUTES', quantity: 350, idempotencyKey: 'ov-1', occurredAt: new Date(Date.now() - 864e5) });
    await grantCredits({ orgId: org.id, amountMinor: 200, reason: 'p', idempotencyKey: 'ov-credit' });
    const inv = { id: 'in_overage_1', customer: cust.providerCustomerId, currency: 'usd', status: 'draft', billing_reason: 'subscription_cycle', period_start: Math.floor((Date.now() - 20 * 864e5) / 1000), period_end: Math.floor((Date.now() + 864e5) / 1000) };
    await expect(billOverage(inv)).resolves.toBeUndefined(); await expect(billOverage(inv)).resolves.toBeUndefined();
    expect((await getBalance(org.id)).balanceMinor).toBe(0);
  });
  it('reconciliation reads subscriptions through the real SDK and tolerates unknown remote objects', async () => {
    await prisma.subscription.create({ data: { orgId: org.id, planId: growth.id, status: 'PAST_DUE', interval: 'MONTH', providerSubscriptionId: 'sub_recon', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 864e6) } });
    const rep = await reconcileBilling(); expect(rep.checked).toBeGreaterThanOrEqual(1); expect(rep.repaired + rep.errors).toBeGreaterThanOrEqual(1); // drift detected; unknown fixture customer is reported, not thrown
  });
});

describe('subscription lifecycle through SIGNED webhooks on real MySQL', () => {
  let o, evtN = 0;
  const sub = (status, extra = {}) => ({ id: 'sub_life', customer: 'cus_life', status, items: { data: [{ price: { id: 'price_growth_month' }, current_period_start: 1750000000, current_period_end: 1752592000 }] }, ...extra });
  const evt = (type, object) => ({ id: `evt_${++evtN}_${Date.now()}`, object: 'event', type, data: { object } });
  beforeAll(async () => { o = await makeOrg('starter'); await prisma.subscription.deleteMany({ where: { orgId: o.id } }); await prisma.billingCustomer.create({ data: { orgId: o.id, providerCustomerId: 'cus_life' } }); });

  it('created → active entitlements; replay of the same event is a no-op; update → trial/period fields', async () => {
    const e = evt('customer.subscription.created', sub('active')); expect((await hook(e)).status).toBe(200); expect((await hook(e)).status).toBe(200);
    expect(await prisma.subscription.count({ where: { orgId: o.id } })).toBe(1); const s = await prisma.subscription.findFirst({ where: { orgId: o.id }, include: { plan: true } });
    expect(s).toMatchObject({ status: 'ACTIVE', providerSubscriptionId: 'sub_life' }); expect(s.plan.code).toBe('growth');
    expect((await prisma.webhookEvent.findUnique({ where: { source_externalId: { source: 'stripe', externalId: e.id } } })).processedAt).toBeTruthy();
    expect(await getEntitlements(o.id)).toMatchObject({ active: true, planCode: 'growth' });
    await hook(evt('customer.subscription.updated', sub('active', { cancel_at_period_end: true }))); expect((await prisma.subscription.findFirst({ where: { orgId: o.id } })).cancelAtPeriodEnd).toBe(true);
  });
  it('payment failure → PAST_DUE with a grace period (access kept), invoice stored; paid invoice recorded', async () => {
    await hook(evt('invoice.payment_failed', { id: 'in_fail_1', customer: 'cus_life', currency: 'usd', total: 19900 }));
    const s = await prisma.subscription.findFirst({ where: { orgId: o.id } }); expect(s.status).toBe('PAST_DUE'); expect(s.graceEndsAt.getTime()).toBeGreaterThan(Date.now() + 6 * 864e5);
    expect((await getEntitlements(o.id)).active).toBe(true); expect(await prisma.invoice.findUnique({ where: { providerInvoiceId: 'in_fail_1' } })).toMatchObject({ status: 'OPEN', totalMinor: 19900 });
    await hook(evt('invoice.paid', { id: 'in_fail_1', customer: 'cus_life', currency: 'usd', total: 19900 })); expect((await prisma.invoice.findUnique({ where: { providerInvoiceId: 'in_fail_1' } })).status).toBe('PAID');
    await prisma.subscription.updateMany({ where: { orgId: o.id }, data: { graceEndsAt: new Date(Date.now() - 1000) } }); expect((await getEntitlements(o.id)).reason).toBe('PAYMENT_FAILED'); // grace expired ⇒ blocked
  });
  it('subscription deleted → CANCELED and access removed', async () => {
    await hook(evt('customer.subscription.deleted', sub('canceled', { canceled_at: 1751000000 })));
    expect((await prisma.subscription.findFirst({ where: { orgId: o.id } })).status).toBe('CANCELED'); expect((await getEntitlements(o.id)).active).toBe(false);
  });
  it('credit purchase webhook grants exactly once; forged org metadata is rejected and retried by Stripe (500)', async () => {
    const s = { id: 'cs_real_1', customer: 'cus_life', payment_status: 'paid', amount_total: 5000, metadata: { kind: 'credits', orgId: o.id } };
    const e = evt('checkout.session.completed', s); await hook(e); await hook(e); expect((await getBalance(o.id)).balanceMinor).toBe(5000);
    const forged = await hook(evt('checkout.session.completed', { ...s, id: 'cs_forged', metadata: { kind: 'credits', orgId: org.id } })); expect(forged.status).toBe(500);
    expect((await getBalance(org.id)).balanceMinor).toBe(0); // victim org untouched
  });
  it('tampered or unsigned webhook bodies are rejected before touching the DB', async () => {
    const e = evt('customer.subscription.deleted', sub('canceled')); const { sig } = sign(e); const before = await prisma.webhookEvent.count();
    expect((await request(app).post('/api/v1/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(JSON.stringify({ ...e, id: 'evt_tampered' }))).status).toBe(400);
    expect((await request(app).post('/api/v1/webhooks/stripe').set('content-type', 'application/json').send(JSON.stringify(e))).status).toBe(400); expect(await prisma.webhookEvent.count()).toBe(before);
  });
});
