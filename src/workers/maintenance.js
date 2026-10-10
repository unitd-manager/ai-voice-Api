import { prisma } from '../core/database/prisma.js';
import { logger } from '../core/logging/logger.js';
import { storage } from '../platform-services/storage/storage.service.js';
import { getVoiceProvider } from '../ai-platform/voice-engine/provider.factory.js';
import { callsService } from '../ai-platform/calls/calls.service.js';
import { billingService, reconcileBilling } from '../saas-platform/billing/billing.service.js';
import { recordUsage, recordGauge } from '../saas-platform/usage-metering/usage.service.js';
import { expireReservations } from '../saas-platform/usage-metering/reservations.service.js';
import { flushApiCounts } from '../saas-platform/usage-metering/api-meter.js';
import { purgeExpiredMemory } from '../ai-platform/conversation-engine/memory.service.js';


// Re-process inbound webhook events that were stored but never marked processed (crash, 5xx, missed queue).
export async function reprocessPendingInbox() {
  const stale = await prisma.webhookEvent.findMany({ where: { processedAt: null, receivedAt: { lt: new Date(Date.now() - 2 * 60e3) } }, take: 100, orderBy: { receivedAt: 'asc' } });
  for (const ev of stale) {
    try {
      if (ev.source === 'vapi') await callsService.applyProviderEvent(getVoiceProvider().parseWebhook(ev.payload));
      else if (ev.source === 'stripe') await billingService.handleStripeEvent(ev.payload);
      await prisma.webhookEvent.update({ where: { id: ev.id }, data: { processedAt: new Date(), error: null } });
    } catch (err) { await prisma.webhookEvent.update({ where: { id: ev.id }, data: { error: String(err.message).slice(0, 500) } }); }
  }
  if (stale.length) logger.info({ count: stale.length }, 'reconciled webhook inbox');
}

// Per-organization retention: delete recordings and transcripts older than the configured window.
export async function enforceRetention() {
  const orgs = await prisma.organization.findMany({ where: { deletedAt: null }, select: { id: true, retentionDays: true } });
  for (const o of orgs) {
    const cutoff = new Date(Date.now() - o.retentionDays * 864e5);
    const recs = await prisma.recording.findMany({ where: { orgId: o.id, deletedAt: null, createdAt: { lt: cutoff } }, take: 500 });
    for (const r of recs) { await storage.delete(r.storageKey).catch(() => {}); await prisma.recording.update({ where: { id: r.id }, data: { deletedAt: new Date() } }); }
    await prisma.transcriptSegment.deleteMany({ where: { call: { orgId: o.id, createdAt: { lt: cutoff } } } });
  }
}

// Replays one stored webhook event (used by the sweep and by the admin "retry" endpoint).
export async function reprocessWebhookEvent(id) {
  const ev = await prisma.webhookEvent.findUnique({ where: { id } });
  if (!ev) return { found: false };
  if (ev.source === 'vapi') await callsService.applyProviderEvent(getVoiceProvider().parseWebhook(ev.payload));
  else if (ev.source === 'stripe') await billingService.handleStripeEvent(ev.payload);
  await prisma.webhookEvent.update({ where: { id }, data: { processedAt: new Date(), error: null } });
  return { found: true, processed: true };
}

// Storage gauge: documents + recordings, per org (current month).
export async function snapshotStorage() {
  const docs = await prisma.knowledgeDocument.groupBy({ by: ['orgId'], _sum: { sizeBytes: true } });
  const recs = await prisma.recording.groupBy({ by: ['orgId'], where: { deletedAt: null }, _sum: { sizeBytes: true } });
  const totals = new Map();
  for (const d of docs) totals.set(d.orgId, (totals.get(d.orgId) ?? 0n) + BigInt(d._sum.sizeBytes ?? 0));
  for (const r of recs) totals.set(r.orgId, (totals.get(r.orgId) ?? 0n) + BigInt(r._sum.sizeBytes ?? 0));
  for (const [orgId, v] of totals) await recordGauge({ orgId, metric: 'STORAGE_BYTES', value: v, mode: 'set' });
  return totals.size;
}

// Monthly phone-number charges, once per number per month (idempotent).
export async function recordPhoneCharges(now = new Date()) {
  const ym = now.toISOString().slice(0, 7);
  const nums = await prisma.phoneNumber.findMany({ where: { monthlyCostMinor: { gt: 0 } } });
  for (const n of nums) await recordUsage({ orgId: n.orgId, metric: 'PHONE_NUMBER_COST', quantity: n.monthlyCostMinor, costMinor: n.monthlyCostMinor, idempotencyKey: `phone:${n.id}:${ym}` });
  return nums.length;
}

export async function dailyMaintenance() {
  const out = {};
  out.expiredReservations = (await expireReservations()).count;
  out.purgedMemory = (await purgeExpiredMemory()).count;
  out.storageOrgs = await snapshotStorage();
  out.phoneCharges = await recordPhoneCharges();
  out.apiCounts = await flushApiCounts(recordGauge);
  await enforceRetention();
  try { out.billing = await reconcileBilling(); } catch (err) { out.billing = { error: err.code ?? 'unavailable' }; } // Stripe may be unconfigured
  logger.info(out, 'daily maintenance complete');
  return out;
}
