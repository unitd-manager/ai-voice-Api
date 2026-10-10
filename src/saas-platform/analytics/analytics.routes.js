import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';

const orgP = z.object({ orgId: z.string().max(40) });
export const analyticsRouter = Router({ mergeParams: true });
analyticsRouter.get('/overview', validate({ params: orgP, query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }) }), guard('analytics:read'), h(async (req, res) => {
  const since = new Date(Date.now() - req.query.days * 864e5);
  const where = { orgId: req.org.id, createdAt: { gte: since } };
  const [byStatus, agg] = await Promise.all([
    prisma.call.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.call.aggregate({ where, _sum: { durationSeconds: true, providerCostMinor: true }, _count: { _all: true } }),
  ]);
  ok(res, { totalCalls: agg._count._all, totalMinutes: Math.ceil((agg._sum.durationSeconds ?? 0) / 60), providerCostMinor: agg._sum.providerCostMinor ?? 0, byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) });
}));
