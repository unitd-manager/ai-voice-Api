import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { authenticate } from '../../core/middleware/auth.js';
import { ok } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { pageQuery, paginate } from '../../core/utils/pagination.js';
import { audit } from '../audit-logs/audit.service.js';
import { grantCredits } from '../credits/credits.service.js';
import { reconcileBilling } from '../billing/billing.service.js';
import { providerHealth } from './provider-health.js';
import { reprocessWebhookEvent } from '../../workers/maintenance.js';

// Platform-operator APIs. Authorization is a DB flag re-read on every request (never trusted from the token).
async function requirePlatformAdmin(req, _res, next) {
  try {
    if (req.auth.type !== 'user') throw AppError.forbidden();
    const u = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { isPlatformAdmin: true, disabledAt: true, deletedAt: true } });
    if (!u?.isPlatformAdmin || u.disabledAt || u.deletedAt) throw AppError.forbidden();
    next();
  } catch (e) { next(e); }
}
const idP = z.object({ id: z.string().max(40) });
export const adminRouter = Router();
adminRouter.use(authenticate, requirePlatformAdmin);

adminRouter.get('/orgs', validate({ query: pageQuery.extend({ q: z.string().max(100).optional() }) }), h(async (req, res) => {
  const rows = await prisma.organization.findMany({ where: { deletedAt: null, ...(req.query.q ? { OR: [{ name: { contains: req.query.q } }, { slug: { contains: req.query.q } }] } : {}) }, orderBy: { createdAt: 'desc' }, take: req.query.limit + 1, ...(req.query.cursor ? { cursor: { id: req.query.cursor }, skip: 1 } : {}), select: { id: true, name: true, slug: true, suspendedAt: true, createdAt: true } });
  const { items, meta } = paginate(rows, req.query.limit); ok(res, items, meta);
}));
adminRouter.get('/orgs/:id', validate({ params: idP }), h(async (req, res) => {
  const o = await prisma.organization.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, slug: true, suspendedAt: true, createdAt: true } });
  if (!o) throw AppError.notFound('Organization not found');
  const [members, calls, sub] = await Promise.all([prisma.membership.count({ where: { orgId: o.id } }), prisma.call.count({ where: { orgId: o.id } }), prisma.subscription.findFirst({ where: { orgId: o.id }, orderBy: { createdAt: 'desc' }, include: { plan: { select: { code: true } } } })]);
  ok(res, { ...o, members, calls, subscription: sub && { status: sub.status, plan: sub.plan.code, currentPeriodEnd: sub.currentPeriodEnd } });
}));
for (const [path, value] of [['suspend', true], ['unsuspend', false]]) {
  adminRouter.post(`/orgs/:id/${path}`, validate({ params: idP }), h(async (req, res) => {
    const r = await prisma.organization.updateMany({ where: { id: req.params.id, deletedAt: null }, data: { suspendedAt: value ? new Date() : null } });
    if (!r.count) throw AppError.notFound('Organization not found');
    req.org = { id: req.params.id }; await audit(req, `admin.org.${path}`, { targetType: 'organization', targetId: req.params.id }); ok(res, {});
  }));
}
adminRouter.post('/orgs/:id/credits', validate({ params: idP, body: z.object({ amountMinor: z.number().int().min(1).max(10_000_000), reason: z.string().min(3).max(200), idempotencyKey: z.string().min(8).max(100) }) }), h(async (req, res) => {
  const r = await grantCredits({ orgId: req.params.id, amountMinor: req.body.amountMinor, reason: `admin: ${req.body.reason}`, idempotencyKey: `admin:${req.body.idempotencyKey}` });
  req.org = { id: req.params.id }; await audit(req, 'admin.credits.grant', { targetType: 'organization', targetId: req.params.id, metadata: { amountMinor: req.body.amountMinor, reason: req.body.reason } }); ok(res, r);
}));
adminRouter.get('/system/health', h(async (_req, res) => ok(res, await providerHealth())));
adminRouter.get('/webhook-events', validate({ query: pageQuery.extend({ unprocessed: z.enum(['true', 'false']).default('true') }) }), h(async (req, res) => {
  const rows = await prisma.webhookEvent.findMany({ where: req.query.unprocessed === 'true' ? { processedAt: null } : {}, orderBy: { receivedAt: 'desc' }, take: req.query.limit + 1, ...(req.query.cursor ? { cursor: { id: req.query.cursor }, skip: 1 } : {}), select: { id: true, source: true, type: true, error: true, receivedAt: true, processedAt: true } });
  const { items, meta } = paginate(rows, req.query.limit); ok(res, items, meta);
}));
adminRouter.post('/webhook-events/:id/retry', validate({ params: idP }), h(async (req, res) => ok(res, await reprocessWebhookEvent(req.params.id))));
adminRouter.post('/billing/reconcile', h(async (_req, res) => ok(res, await reconcileBilling())));
