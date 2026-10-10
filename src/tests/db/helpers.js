import { realPrisma as prisma } from './db-client.js';
import { seedPlans } from '../../saas-platform/plans/seed-plans.js';

export async function resetDb() {
  const tables = await prisma.$queryRawUnsafe("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()");
  // FOREIGN_KEY_CHECKS is per-connection: do everything on ONE connection via an interactive transaction.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=0');
    for (const { t } of tables) await tx.$executeRawUnsafe(`DELETE FROM \`${t}\``);
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=1');
  }, { timeout: 30000 });
  await seedPlans(prisma);
}
let n = 0;
export const uniq = (p = 'x') => `${p}-${Date.now()}-${++n}`;
export async function makeOrg(planCode = 'starter', name = uniq('org')) {
  const org = await prisma.organization.create({ data: { name, slug: uniq('slug') } });
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  const now = new Date();
  await prisma.subscription.create({ data: { orgId: org.id, planId: plan.id, status: 'ACTIVE', interval: 'MONTH', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 864e5) } });
  return org;
}
export async function makeUser(orgId, role = 'OWNER') {
  const u = await prisma.user.create({ data: { email: `${uniq('u')}@x.co`, passwordHash: 'x' } });
  if (orgId) await prisma.membership.create({ data: { userId: u.id, orgId, role } });
  return u;
}
