import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { authenticate } from '../../core/middleware/auth.js';
import { ok } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { verifyPassword } from '../../core/security/crypto.js';

export const usersRouter = Router();
usersRouter.use(authenticate, (req, _res, next) => (req.auth.type === 'user' ? next() : next(AppError.forbidden())));
usersRouter.get('/me', h(async (req, res) => { const u = await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { id: true, email: true, name: true, emailVerifiedAt: true, createdAt: true } }); ok(res, u); }));
usersRouter.patch('/me', validate({ body: z.object({ name: z.string().min(1).max(100) }).strict() }), h(async (req, res) => ok(res, await prisma.user.update({ where: { id: req.auth.userId }, data: req.body, select: { id: true, email: true, name: true } }))));
usersRouter.get('/me/export', h(async (req, res) => {
  const [user, memberships, sessions] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.auth.userId }, select: { id: true, email: true, name: true, createdAt: true } }),
    prisma.membership.findMany({ where: { userId: req.auth.userId }, select: { orgId: true, role: true, createdAt: true } }),
    prisma.session.findMany({ where: { userId: req.auth.userId }, select: { createdAt: true, ip: true, userAgent: true } }),
  ]);
  res.setHeader('Content-Disposition', 'attachment; filename="account-export.json"'); ok(res, { user, memberships, sessions });
}));
// Soft-delete: requires password; refuses while the user is the only owner of an org that has other members.
usersRouter.post('/me/delete', validate({ body: z.object({ password: z.string().max(128) }) }), h(async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.auth.userId } });
  if (!(await verifyPassword(req.body.password, u.passwordHash))) throw AppError.unauthorized('Invalid password');
  const owned = await prisma.membership.findMany({ where: { userId: u.id, role: 'OWNER' } });
  for (const m of owned) {
    const [otherOwners, others] = await Promise.all([prisma.membership.count({ where: { orgId: m.orgId, role: 'OWNER', userId: { not: u.id } } }), prisma.membership.count({ where: { orgId: m.orgId, userId: { not: u.id } } })]);
    if (!otherOwners && others) throw AppError.conflict('Transfer ownership of your organizations before deleting your account');
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: u.id }, data: { deletedAt: new Date(), email: `deleted+${u.id}@invalid.local`, name: null } }),
    prisma.session.updateMany({ where: { userId: u.id }, data: { revokedAt: new Date() } }),
  ]);
  ok(res, {});
}));
