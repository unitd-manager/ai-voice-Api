import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { getStripe } from '../payments/stripe.client.js';
import { env } from '../../core/config/env.js';
import { calculateOverage } from '../usage-metering/overage.js';
import { grantCredits, consumeUpTo } from '../credits/credits.service.js';
import { logger } from '../../core/logging/logger.js';

const STATUS = { trialing: 'TRIALING', active: 'ACTIVE', past_due: 'PAST_DUE', canceled: 'CANCELED', incomplete: 'INCOMPLETE', incomplete_expired: 'CANCELED', unpaid: 'PAST_DUE' };
const GRACE_MS = 7 * 864e5;
const ts = (s) => (s ? new Date(s * 1000) : null);

export const billingService = {
  // Price and plan are resolved from OUR database by id; the client never supplies amounts.
  async createCheckout(orgId, email, { planCode, interval }) {
    const price = await prisma.planPrice.findFirst({ where: { interval, active: true, plan: { code: planCode, isPublic: true } }, include: { plan: true } });
    if (!price?.providerPriceId) throw AppError.notFound('Plan price not available');
    const stripe = getStripe();
    let cust = await prisma.billingCustomer.findUnique({ where: { orgId } });
    if (!cust) {
      const c = await stripe.customers.create({ email, metadata: { orgId } });
      cust = await prisma.billingCustomer.create({ data: { orgId, providerCustomerId: c.id, email } });
    }
    const s = await stripe.checkout.sessions.create({ mode: 'subscription', customer: cust.providerCustomerId, line_items: [{ price: price.providerPriceId, quantity: 1 }], success_url: `${env.APP_URL}/billing/success`, cancel_url: `${env.APP_URL}/billing/cancel`, metadata: { orgId } });
    return { url: s.url };
  },
  // Credit packs are fixed server-side; the amount charged comes from our price list, never the client.
  async createCreditCheckout(orgId, amountMinor) {
    const stripe = getStripe();
    let cust = await prisma.billingCustomer.findUnique({ where: { orgId } });
    if (!cust) throw AppError.conflict('Subscribe to a plan before buying credits');
    const s = await stripe.checkout.sessions.create({ mode: 'payment', customer: cust.providerCustomerId, line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amountMinor, product_data: { name: 'Prepaid call credits' } } }], success_url: `${env.APP_URL}/billing/success`, cancel_url: `${env.APP_URL}/billing/cancel`, metadata: { orgId, kind: 'credits', amountMinor: String(amountMinor) } });
    return { url: s.url };
  },
  async createPortal(orgId) {
    const cust = await prisma.billingCustomer.findUnique({ where: { orgId } });
    if (!cust) throw AppError.notFound('No billing account');
    const s = await getStripe().billingPortal.sessions.create({ customer: cust.providerCustomerId, return_url: `${env.APP_URL}/billing` });
    return { url: s.url };
  },
  listInvoices: (orgId) => prisma.invoice.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 50 }),

  async handleStripeEvent(event) {
    const o = event.data.object;
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': return syncSubscription(o, event.type === 'customer.subscription.deleted');
      case 'invoice.paid': return upsertInvoice(o, 'PAID');
      case 'invoice.payment_failed': {
        await upsertInvoice(o, 'OPEN');
        const cust = await prisma.billingCustomer.findUnique({ where: { providerCustomerId: o.customer } });
        if (cust) await prisma.subscription.updateMany({ where: { orgId: cust.orgId, status: { in: ['ACTIVE', 'TRIALING'] } }, data: { status: 'PAST_DUE', graceEndsAt: new Date(Date.now() + GRACE_MS) } });
        return;
      }
      case 'checkout.session.completed': {
        if (o.metadata?.kind !== 'credits' || o.payment_status !== 'paid') return;
        const cust = await prisma.billingCustomer.findUnique({ where: { providerCustomerId: o.customer } });
        if (!cust || cust.orgId !== o.metadata.orgId) throw new Error('Credit purchase does not match billing customer'); // metadata alone is not trusted
        return void await grantCredits({ orgId: cust.orgId, amountMinor: o.amount_total, reason: 'purchase', idempotencyKey: `stripe:${o.id}` });
      }
      case 'invoice.created': return billOverage(o);
      default: return; // unhandled types are acknowledged (and stored) but ignored
    }
  },
};

export async function syncSubscription(sub, deleted) {
  const cust = await prisma.billingCustomer.findUnique({ where: { providerCustomerId: sub.customer } });
  if (!cust) throw new Error(`Unknown billing customer ${sub.customer}`); // retried by Stripe until the customer row exists
  const item = sub.items?.data?.[0];
  const price = item && await prisma.planPrice.findFirst({ where: { providerPriceId: item.price.id } });
  if (!price) throw new Error('Unknown price');
  const status = deleted ? 'CANCELED' : (STATUS[sub.status] ?? 'INCOMPLETE');
  const data = { orgId: cust.orgId, planId: price.planId, interval: price.interval, status, currentPeriodStart: ts(item.current_period_start ?? sub.current_period_start) ?? new Date(), currentPeriodEnd: ts(item.current_period_end ?? sub.current_period_end) ?? new Date(), trialEndsAt: ts(sub.trial_end), cancelAtPeriodEnd: !!sub.cancel_at_period_end, canceledAt: ts(sub.canceled_at), graceEndsAt: status === 'PAST_DUE' ? new Date(Date.now() + GRACE_MS) : null };
  await prisma.subscription.upsert({ where: { providerSubscriptionId: sub.id }, create: { ...data, providerSubscriptionId: sub.id }, update: data });
}
async function upsertInvoice(inv, status) {
  const cust = await prisma.billingCustomer.findUnique({ where: { providerCustomerId: inv.customer } });
  if (!cust) throw new Error(`Unknown billing customer ${inv.customer}`);
  const data = { orgId: cust.orgId, status, currency: String(inv.currency).toUpperCase(), totalMinor: inv.total, hostedUrl: inv.hosted_invoice_url ?? null, periodStart: ts(inv.period_start), periodEnd: ts(inv.period_end) };
  await prisma.invoice.upsert({ where: { providerInvoiceId: inv.id }, create: { ...data, providerInvoiceId: inv.id }, update: data });
}

// Usage-based overage: when Stripe creates the renewal invoice (still a draft for ~1h), add an invoice item for
// minutes beyond the plan's included amount, after applying prepaid credits. Safe to replay (idempotent end to end).
export async function billOverage(inv) {
  if (inv.billing_reason !== 'subscription_cycle' || inv.status !== 'draft') return;
  const cust = await prisma.billingCustomer.findUnique({ where: { providerCustomerId: inv.customer } });
  if (!cust) throw new Error(`Unknown billing customer ${inv.customer}`);
  const sub = await prisma.subscription.findFirst({ where: { orgId: cust.orgId, status: { in: ['ACTIVE', 'PAST_DUE'] } }, orderBy: { createdAt: 'desc' }, include: { plan: true } });
  const lim = sub?.plan.entitlements;
  if (!lim || lim.callMinutes === -1 || !lim.overageCentsPerMinute) return;
  const start = new Date(inv.period_start * 1000); const end = new Date(inv.period_end * 1000);
  const used = await prisma.usageEvent.aggregate({ where: { orgId: cust.orgId, metric: 'CALL_MINUTES', occurredAt: { gte: start, lt: end } }, _sum: { quantity: true } });
  const { amountMinor, overageUnits } = calculateOverage({ used: used._sum.quantity ?? 0n, included: lim.callMinutes, rateMinor: lim.overageCentsPerMinute });
  if (amountMinor <= 0) return;
  const credit = await consumeUpTo({ orgId: cust.orgId, maxMinor: amountMinor, reason: `overage ${inv.id}`, idempotencyKey: `overage:${inv.id}` });
  const charge = amountMinor - credit.consumedMinor;
  logger.info({ orgId: cust.orgId, overageMinutes: String(overageUnits), amountMinor, credited: credit.consumedMinor, charge }, 'overage computed');
  if (charge <= 0) return;
  await getStripe().invoiceItems.create({ customer: inv.customer, invoice: inv.id, amount: charge, currency: inv.currency, description: `Overage: ${overageUnits} call minutes` }, { idempotencyKey: `overage-item-${inv.id}` });
}

// Compares local subscription state with Stripe and repairs drift (missed/failed webhooks).
export async function reconcileBilling() {
  const subs = await prisma.subscription.findMany({ where: { providerSubscriptionId: { not: null }, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'INCOMPLETE'] } }, take: 500 });
  const report = { checked: subs.length, repaired: 0, errors: 0 };
  const stripe = getStripe();
  for (const local of subs) {
    try {
      const remote = await stripe.subscriptions.retrieve(local.providerSubscriptionId);
      const expected = STATUS[remote.status] ?? 'INCOMPLETE';
      if (expected !== local.status) { await syncSubscription(remote, false); report.repaired++; }
    } catch (err) {
      if (err?.code === 'resource_missing') { await prisma.subscription.update({ where: { id: local.id }, data: { status: 'CANCELED', canceledAt: new Date() } }); report.repaired++; }
      else { report.errors++; logger.error({ err: err.message, subscriptionId: local.id }, 'billing reconcile error'); }
    }
  }
  return report;
}
