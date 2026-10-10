import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';

export const CREDIT_PACKS_MINOR = [1000, 5000, 20000]; // server-defined; the client can only choose among these

export async function getBalance(orgId) {
  const a = await prisma.creditAccount.findUnique({ where: { orgId } });
  return { balanceMinor: a?.balanceMinor ?? 0, currency: a?.currency ?? 'USD' };
}

// Idempotent on idempotencyKey: re-delivering the same payment event can never double-grant.
export async function grantCredits({ orgId, amountMinor, reason, idempotencyKey }) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw AppError.badRequest('Invalid credit amount');
  await prisma.creditAccount.createMany({ data: [{ orgId }], skipDuplicates: true }); // race-free "get or create"
  const acct = await prisma.creditAccount.findUnique({ where: { orgId } });
  return prisma.$transaction(async (tx) => {
    try { await tx.creditTransaction.create({ data: { accountId: acct.id, deltaMinor: amountMinor, reason, idempotencyKey } }); }
    catch (e) { if (e?.code === 'P2002') return { granted: false, duplicate: true }; throw e; }
    await tx.creditAccount.update({ where: { id: acct.id }, data: { balanceMinor: { increment: amountMinor } } });
    return { granted: true };
  });
}

// Consumes up to `maxMinor` (never below zero). A replay of the same key reports what was consumed the FIRST time
// (checked before anything else, even when the balance has since reached zero). The conditional UPDATE makes overdraft
// impossible under concurrency.
export async function consumeUpTo({ orgId, maxMinor, reason, idempotencyKey }) {
  const prev = await prisma.creditTransaction.findUnique({ where: { idempotencyKey } });
  if (prev) return { consumedMinor: Math.max(0, -prev.deltaMinor), duplicate: true };
  const acct = await prisma.creditAccount.findUnique({ where: { orgId } });
  if (!acct || acct.balanceMinor <= 0 || maxMinor <= 0) return { consumedMinor: 0 };
  const take = Math.min(acct.balanceMinor, maxMinor);
  return prisma.$transaction(async (tx) => {
    const r = await tx.creditAccount.updateMany({ where: { id: acct.id, balanceMinor: { gte: take } }, data: { balanceMinor: { decrement: take } } });
    if (r.count !== 1) return { consumedMinor: 0 }; // lost a race; caller bills the full amount instead
    try { await tx.creditTransaction.create({ data: { accountId: acct.id, deltaMinor: -take, reason, idempotencyKey } }); }
    catch (e) { if (e?.code !== 'P2002') throw e; throw Object.assign(new Error('concurrent replay'), { retryReplay: true }); } // rolls back the decrement
    return { consumedMinor: take };
  }).catch(async (e) => {
    if (e?.retryReplay) { const again = await prisma.creditTransaction.findUnique({ where: { idempotencyKey } }); return { consumedMinor: again ? Math.max(0, -again.deltaMinor) : 0, duplicate: true }; }
    throw e;
  });
}
