import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { getPeriodUsage } from '../usage-metering/usage.service.js';

const ACTIVE = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

export async function getEntitlements(orgId, now = new Date()) {
  const sub = await prisma.subscription.findFirst({ where: { orgId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' }, include: { plan: true } });
  if (!sub) return { active: false, reason: 'NO_SUBSCRIPTION', limits: null };
  // PAST_DUE keeps access only until the grace period ends.
  if (sub.status === 'PAST_DUE' && (!sub.graceEndsAt || sub.graceEndsAt < now)) return { active: false, reason: 'PAYMENT_FAILED', limits: null };
  if (sub.status === 'TRIALING' && sub.trialEndsAt && sub.trialEndsAt < now) return { active: false, reason: 'TRIAL_ENDED', limits: null };
  return { active: true, status: sub.status, planCode: sub.plan.code, limits: sub.plan.entitlements };
}

const unlimited = (v) => v === -1;

// Central gate. Called by API routes, workers and webhook handlers before any metered operation.
export async function assertCanStartCall(orgId) {
  const ent = await getEntitlements(orgId);
  if (!ent.active) throw new AppError(402, 'SUBSCRIPTION_REQUIRED', 'An active subscription is required');
  const { limits } = ent;
  const active = await prisma.call.count({ where: { orgId, status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } } });
  if (active >= limits.concurrentCalls) throw new AppError(429, 'CONCURRENCY_LIMIT', 'Concurrent call limit reached');
  if (limits.hardCap && !unlimited(limits.callMinutes)) {
    const used = await getPeriodUsage(orgId, 'CALL_MINUTES');
    if (used >= limits.callMinutes) throw new AppError(402, 'USAGE_CAP_REACHED', 'Included call minutes exhausted');
  }
  return ent;
}
export async function assertWithinCount(orgId, key, current) {
  const ent = await getEntitlements(orgId);
  if (!ent.active) throw new AppError(402, 'SUBSCRIPTION_REQUIRED', 'An active subscription is required');
  const lim = ent.limits[key];
  if (!unlimited(lim) && current >= lim) throw new AppError(403, 'PLAN_LIMIT', `Plan limit reached for ${key}`);
}
