import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { periodStartUTC } from './overage.js';

// Reserve capacity BEFORE starting a metered operation so parallel requests cannot jointly exceed a hard cap.
// The org row is locked (SELECT … FOR UPDATE) so reservations for one org are serialized.
export async function reserve({ orgId, metric = 'CALL_MINUTES', quantity, limit, callId, ttlMs = 2 * 3600e3, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM Organization WHERE id = ${orgId} FOR UPDATE`;
    const agg = await tx.usageAggregate.findUnique({ where: { orgId_metric_periodStart: { orgId, metric, periodStart: periodStartUTC(now) } } });
    const held = await tx.usageReservation.aggregate({ where: { orgId, metric, status: 'HELD', expiresAt: { gt: now } }, _sum: { quantity: true } });
    const used = Number(agg?.quantity ?? 0n) + Number(held._sum.quantity ?? 0n);
    if (used + quantity > limit) throw new AppError(402, 'USAGE_CAP_REACHED', 'Included usage would be exceeded');
    return tx.usageReservation.create({ data: { orgId, metric, quantity: BigInt(quantity), callId, expiresAt: new Date(now.getTime() + ttlMs) } });
  });
}
export const settleReservation = (callId, status = 'COMMITTED') => prisma.usageReservation.updateMany({ where: { callId, status: 'HELD' }, data: { status } });
export const expireReservations = (now = new Date()) => prisma.usageReservation.updateMany({ where: { status: 'HELD', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } });
