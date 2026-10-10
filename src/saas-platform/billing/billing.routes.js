import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { idempotent } from '../../core/middleware/idempotency.js';
import { ok } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { billingService as svc } from './billing.service.js';
import { getEntitlements } from '../entitlements/entitlements.service.js';
import { getPeriodUsage } from '../usage-metering/usage.service.js';
import { AppError } from '../../core/errors/app-error.js';

const orgP = z.object({ orgId: z.string().max(40) });
export const billingRouter = Router({ mergeParams: true });
export const plansRouter = Router();

plansRouter.get('/', h(async (_req, res) => ok(res, await prisma.plan.findMany({ where: { isPublic: true }, include: { prices: { where: { active: true }, select: { interval: true, currency: true, amountMinor: true } } } }))));

billingRouter.get('/', validate({ params: orgP }), guard('billing:read'), h(async (req, res) => {
  const ent = await getEntitlements(req.org.id);
  ok(res, { entitlements: ent, usage: { callMinutes: await getPeriodUsage(req.org.id, 'CALL_MINUTES') } });
}));
billingRouter.get('/invoices', validate({ params: orgP }), guard('billing:read'), h(async (req, res) => ok(res, await svc.listInvoices(req.org.id))));
billingRouter.post('/checkout', validate({ params: orgP, body: z.object({ planCode: z.string().max(40), interval: z.enum(['MONTH', 'YEAR']) }) }), guard('billing:manage'), idempotent, h(async (req, res) => {
  if (req.auth.type !== 'user') throw AppError.forbidden();
  const user = await prisma.user.findUnique({ where: { id: req.auth.userId } });
  ok(res, await svc.createCheckout(req.org.id, user.email, req.body));
}));
billingRouter.post('/portal', validate({ params: orgP }), guard('billing:manage'), h(async (req, res) => ok(res, await svc.createPortal(req.org.id))));
