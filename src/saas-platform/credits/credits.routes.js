import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { idempotent } from '../../core/middleware/idempotency.js';
import { ok } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { getBalance, CREDIT_PACKS_MINOR } from './credits.service.js';
import { billingService } from '../billing/billing.service.js';

const orgP = z.object({ orgId: z.string().max(40) });
export const creditsRouter = Router({ mergeParams: true });
creditsRouter.get('/', validate({ params: orgP }), guard('billing:read'), h(async (req, res) => ok(res, { ...(await getBalance(req.org.id)), packsMinor: CREDIT_PACKS_MINOR })));
creditsRouter.get('/transactions', validate({ params: orgP }), guard('billing:read'), h(async (req, res) => {
  const a = await prisma.creditAccount.findUnique({ where: { orgId: req.org.id } });
  ok(res, a ? await prisma.creditTransaction.findMany({ where: { accountId: a.id }, orderBy: { createdAt: 'desc' }, take: 100 }) : []);
}));
creditsRouter.post('/checkout', validate({ params: orgP, body: z.object({ amountMinor: z.number().int() }) }), guard('billing:manage'), idempotent, h(async (req, res) => {
  if (!CREDIT_PACKS_MINOR.includes(req.body.amountMinor)) throw AppError.badRequest('Unknown credit pack');
  ok(res, await billingService.createCreditCheckout(req.org.id, req.body.amountMinor));
}));
