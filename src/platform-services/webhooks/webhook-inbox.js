import { prisma } from '../../core/database/prisma.js';
import { logger } from '../../core/logging/logger.js';

// Durable, idempotent inbound webhook processing:
//  1. persist the event (unique on source+externalId) BEFORE doing anything else
//  2. duplicates that were already processed are acknowledged without side effects
//  3. failures are recorded and surfaced as errors so the provider retries
export async function receiveWebhook({ source, externalId, type, payload }, processFn) {
  let row;
  try {
    row = await prisma.webhookEvent.create({ data: { source, externalId, type, payload, claimedAt: new Date() } }); // creator holds the claim
  } catch (e) {
    if (e?.code !== 'P2002') throw e;
    row = await prisma.webhookEvent.findUnique({ where: { source_externalId: { source, externalId } } });
    if (row.processedAt) return { duplicate: true };
    // Redelivery of an unprocessed event: claim it atomically so two concurrent deliveries cannot both process it.
    // A stale claim (crashed worker, >60s) can be taken over.
    const claim = await prisma.webhookEvent.updateMany({ where: { id: row.id, processedAt: null, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(Date.now() - 60_000) } }] }, data: { claimedAt: new Date() } });
    if (claim.count !== 1) return { duplicate: true, inProgress: true };
  }
  try {
    await processFn(row);
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { processedAt: new Date(), error: null } });
    return { duplicate: false };
  } catch (err) {
    logger.error({ err, source, externalId }, 'webhook processing failed');
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { error: String(err.message).slice(0, 500) } }).catch(() => {});
    throw err;
  }
}
