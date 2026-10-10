import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { authenticate, guard } from '../../core/middleware/auth.js';
import { ok, created } from '../../core/response/respond.js';
import { organizationsService as svc } from './organizations.service.js';
import { audit, listAudit } from '../audit-logs/audit.service.js';
import { pageQuery, paginate } from '../../core/utils/pagination.js';
import { prisma } from '../../core/database/prisma.js';

const role = z.enum(['OWNER', 'ADMIN', 'DEVELOPER', 'ANALYST', 'VIEWER']);
const orgParam = z.object({ orgId: z.string().min(1).max(40) });
const memberParams = orgParam.extend({ userId: z.string().min(1).max(40) });

export const organizationsRouter = Router();
organizationsRouter.get('/', authenticate, h(async (req, res) => {
  if (req.auth.type !== 'user') return ok(res, []);
  ok(res, (await svc.listForUser(req.auth.userId)).map((m) => ({ ...m.org, role: m.role })));
}));
organizationsRouter.post('/invitations/accept', authenticate, validate({ body: z.object({ token: z.string().min(20).max(200) }) }), h(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth.userId } });
  ok(res, await svc.acceptInvite(user.id, user.email, req.body.token));
}));
organizationsRouter.get('/:orgId', validate({ params: orgParam }), guard('org:read'), h(async (req, res) => ok(res, await svc.get(req.org.id))));
organizationsRouter.patch('/:orgId', validate({ params: orgParam, body: z.object({ name: z.string().min(2).max(100).optional(), retentionDays: z.number().int().min(1).max(3650).optional(), settings: z.record(z.any()).optional() }).strict() }), guard('org:update'), h(async (req, res) => {
  const r = await svc.update(req.org.id, req.body); await audit(req, 'org.update', { targetType: 'organization', targetId: req.org.id }); ok(res, r);
}));
organizationsRouter.get('/:orgId/members', validate({ params: orgParam }), guard('org:read'), h(async (req, res) =>
  ok(res, (await svc.listMembers(req.org.id)).map((m) => ({ userId: m.userId, role: m.role, email: m.user.email, name: m.user.name })))));
organizationsRouter.post('/:orgId/invitations', validate({ params: orgParam, body: z.object({ email: z.string().email().transform((s) => s.toLowerCase()), role: role.default('VIEWER') }) }), guard('members:manage'), h(async (req, res) => {
  const r = await svc.invite(req.org.id, req.org.role, req.auth.userId, req.body); await audit(req, 'member.invite', { metadata: { email: req.body.email, role: req.body.role } }); created(res, r);
}));
organizationsRouter.patch('/:orgId/members/:userId', validate({ params: memberParams, body: z.object({ role }) }), guard('members:manage'), h(async (req, res) => {
  const r = await svc.changeRole(req.org.id, req.org.role, req.params.userId, req.body.role); await audit(req, 'member.role_change', { targetId: req.params.userId, metadata: { role: req.body.role } }); ok(res, r);
}));
organizationsRouter.delete('/:orgId/members/:userId', validate({ params: memberParams }), guard('members:manage'), h(async (req, res) => {
  await svc.removeMember(req.org.id, req.org.role, req.params.userId); await audit(req, 'member.remove', { targetId: req.params.userId }); ok(res, {});
}));
organizationsRouter.get('/:orgId/audit-logs', validate({ params: orgParam, query: pageQuery }), guard('audit:read'), h(async (req, res) => {
  const { items, meta } = paginate(await listAudit(req.org.id, { take: req.query.limit, cursor: req.query.cursor }), req.query.limit); ok(res, items, meta);
}));
