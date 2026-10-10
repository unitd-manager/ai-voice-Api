import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { pageQuery, paginate } from '../../core/utils/pagination.js';

const orgP = z.object({ orgId: z.string().max(40) });
export const notificationsRouter = Router({ mergeParams: true });
notificationsRouter.get('/', validate({ params: orgP, query: pageQuery }), guard('org:read'), h(async (req, res) => {
  const rows = await prisma.notification.findMany({ where: { orgId: req.org.id, OR: [{ userId: null }, { userId: req.auth.userId ?? '__none__' }] }, orderBy: { createdAt: 'desc' }, take: req.query.limit + 1, ...(req.query.cursor ? { cursor: { id: req.query.cursor }, skip: 1 } : {}) });
  const { items, meta } = paginate(rows, req.query.limit); ok(res, items, meta);
}));
notificationsRouter.post('/:id/read', validate({ params: orgP.extend({ id: z.string().max(40) }) }), guard('org:read'), h(async (req, res) => { await prisma.notification.updateMany({ where: { id: req.params.id, orgId: req.org.id }, data: { readAt: new Date() } }); ok(res, {}); }));
