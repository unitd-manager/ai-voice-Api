import { prisma } from '../../core/database/prisma.js';
import { getEntitlements } from '../entitlements/entitlements.service.js';
import { getPeriodUsage } from './usage.service.js';
import { periodStartUTC } from './overage.js';
import { sendEmail } from '../../platform-services/email/email.service.js';
import { emitEvent } from '../../platform-services/webhooks/outgoing/outgoing.service.js';

export const THRESHOLDS = [80, 100];

// Pure: which thresholds does `used` cross for `included`?
export const crossedThresholds = (used, included) => (included > 0 ? THRESHOLDS.filter((t) => used * 100 >= included * t) : []);

// Idempotent per (org, period, threshold) through Notification.dedupeKey, so each alert is sent once a month.
export async function checkUsageAlerts(orgId, now = new Date()) {
  const ent = await getEntitlements(orgId, now);
  const included = ent.limits?.callMinutes;
  if (!ent.active || !included || included < 0) return [];
  const used = await getPeriodUsage(orgId, 'CALL_MINUTES', now);
  const sent = [];
  for (const t of crossedThresholds(used, included)) {
    const dedupeKey = `usage:${orgId}:${periodStartUTC(now).toISOString().slice(0, 7)}:${t}`;
    try {
      await prisma.notification.create({ data: { orgId, type: 'usage.threshold', title: `You have used ${t}% of your included call minutes`, body: `${used} of ${included} minutes used this billing month.`, dedupeKey } });
    } catch (e) { if (e?.code === 'P2002') continue; throw e; }
    sent.push(t);
    await emitEvent(orgId, 'usage.threshold', { threshold: t, used, included }).catch(() => {});
    const owners = await prisma.membership.findMany({ where: { orgId, role: { in: ['OWNER', 'ADMIN'] } }, include: { user: { select: { email: true } } } });
    for (const m of owners) await sendEmail({ to: m.user.email, subject: `Usage alert: ${t}% of included minutes`, text: `${used} of ${included} call minutes used this month.` });
  }
  return sent;
}
