import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';

const orgP = z.object({ orgId: z.string().max(40) });
export const usageRouter = Router({ mergeParams: true });
usageRouter.get('/', validate({ params: orgP }), guard('usage:read'), h(async (req, res) =>
  ok(res, (await prisma.usageAggregate.findMany({ where: { orgId: req.org.id }, orderBy: { periodStart: 'desc' }, take: 120 })).map((a) => ({ metric: a.metric, periodStart: a.periodStart, quantity: Number(a.quantity), costMinor: a.costMinor })))));
// CSV export; cells beginning with = + - @ are prefixed to block spreadsheet formula injection.
const cell = (v) => { const s = String(v); return /^[=+\-@]/.test(s) ? `'${s}` : s; };
usageRouter.get('/export.csv', validate({ params: orgP }), guard('usage:read'), h(async (req, res) => {
  const rows = await prisma.usageEvent.findMany({ where: { orgId: req.org.id }, orderBy: { occurredAt: 'desc' }, take: 10000 });
  res.type('text/csv').send(['occurredAt,metric,quantity,costMinor', ...rows.map((r) => [r.occurredAt.toISOString(), r.metric, r.quantity, r.costMinor].map(cell).join(','))].join('\n'));
}));
