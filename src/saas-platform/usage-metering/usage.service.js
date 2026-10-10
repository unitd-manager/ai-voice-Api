import { randomUUID } from 'node:crypto';
import { prisma } from '../../core/database/prisma.js';
import { periodStartUTC } from './overage.js';

// Idempotent and race-free:
//  * the (orgId, idempotencyKey) unique index makes the ledger insert the single source of "already counted";
//  * the monthly aggregate is bumped with one atomic INSERT … ON DUPLICATE KEY UPDATE, so concurrent first-time writers
//    cannot collide (a read-then-insert upsert loses events under concurrency) and increments are never lost.
// The ledger row and the aggregate change commit together.
export async function recordUsage({ orgId, metric, quantity, costMinor = 0, idempotencyKey, callId, occurredAt = new Date() }) {
  return prisma.$transaction(async (tx) => {
    try {
      await tx.usageEvent.create({ data: { orgId, metric, quantity: BigInt(quantity), costMinor, idempotencyKey, callId, occurredAt } });
    } catch (e) {
      if (e?.code === 'P2002') return { recorded: false, duplicate: true }; // already counted
      throw e;
    }
    await bumpAggregate(tx, { orgId, metric, periodStart: periodStartUTC(occurredAt), quantity: BigInt(quantity), costMinor, mode: 'add' });
    return { recorded: true };
  });
}

async function bumpAggregate(tx, { orgId, metric, periodStart, quantity, costMinor = 0, mode }) {
  const id = randomUUID();
  // One atomic statement per mode (no dynamic SQL fragments: everything stays parameterized).
  if (mode === 'add') return tx.$executeRaw`INSERT INTO UsageAggregate (id, orgId, metric, periodStart, quantity, costMinor) VALUES (${id}, ${orgId}, ${metric}, ${periodStart}, ${quantity}, ${costMinor}) ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), costMinor = costMinor + VALUES(costMinor)`;
  if (mode === 'max') return tx.$executeRaw`INSERT INTO UsageAggregate (id, orgId, metric, periodStart, quantity, costMinor) VALUES (${id}, ${orgId}, ${metric}, ${periodStart}, ${quantity}, 0) ON DUPLICATE KEY UPDATE quantity = GREATEST(quantity, VALUES(quantity))`;
  return tx.$executeRaw`INSERT INTO UsageAggregate (id, orgId, metric, periodStart, quantity, costMinor) VALUES (${id}, ${orgId}, ${metric}, ${periodStart}, ${quantity}, 0) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)`;
}

export async function getPeriodUsage(orgId, metric, at = new Date()) {
  const row = await prisma.usageAggregate.findUnique({ where: { orgId_metric_periodStart: { orgId, metric, periodStart: periodStartUTC(at) } } });
  return row ? Number(row.quantity) : 0;
}

// Gauge metrics (storage, concurrency, API requests) are not additive: set the value, or keep the maximum. Atomic.
export async function recordGauge({ orgId, metric, value, mode = 'set', at = new Date() }) {
  return prisma.$transaction((tx) => bumpAggregate(tx, { orgId, metric, periodStart: periodStartUTC(at), quantity: BigInt(value), mode }));
}
