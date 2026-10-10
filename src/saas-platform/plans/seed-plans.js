import { DEFAULT_PLANS } from './default-plans.js';

// Idempotent upsert of plans and USD prices; never deletes anything. Used by prisma/seed.js and by tests.
export async function seedPlans(prisma) {
  for (const p of DEFAULT_PLANS) {
    const plan = await prisma.plan.upsert({ where: { code: p.code }, update: { name: p.name, entitlements: p.entitlements }, create: { code: p.code, name: p.name, entitlements: p.entitlements } });
    for (const price of p.prices) {
      await prisma.planPrice.upsert({ where: { planId_interval_currency: { planId: plan.id, interval: price.interval, currency: 'USD' } }, update: { amountMinor: price.amountMinor }, create: { planId: plan.id, interval: price.interval, currency: 'USD', amountMinor: price.amountMinor } });
    }
  }
  return DEFAULT_PLANS.map((p) => p.code);
}
