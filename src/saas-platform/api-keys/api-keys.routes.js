import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok, created } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { randomToken, sha256 } from '../../core/security/crypto.js';
import { ROLE_RANK } from '../../core/authorization/permissions.js';
import { AppError } from '../../core/errors/app-error.js';
import { audit } from '../audit-logs/audit.service.js';

const orgParam = z.object({ orgId: z.string().max(40) });
export const apiKeysRouter = Router({ mergeParams: true });

apiKeysRouter.get('/', validate({ params: orgParam }), guard('apikeys:manage'), h(async (req, res) =>
  ok(res, await prisma.apiKey.findMany({ where: { orgId: req.org.id }, select: { id: true, name: true, prefix: true, role: true, lastUsedAt: true, revokedAt: true, createdAt: true } }))));

apiKeysRouter.post('/', validate({ params: orgParam, body: z.object({ name: z.string().min(1).max(80), role: z.enum(['ADMIN', 'DEVELOPER', 'ANALYST', 'VIEWER']).default('DEVELOPER') }) }), guard('apikeys:manage'), h(async (req, res) => {
  if (req.auth.type === 'apiKey') throw AppError.forbidden('API keys cannot create API keys');
  if (ROLE_RANK[req.body.role] > ROLE_RANK[req.org.role]) throw AppError.forbidden();
  const secret = `va_${randomToken(32)}`;
  const key = await prisma.apiKey.create({ data: { orgId: req.org.id, name: req.body.name, role: req.body.role, prefix: secret.slice(0, 10), keyHash: sha256(secret), createdById: req.auth.userId } });
  await audit(req, 'apikey.create', { targetType: 'apiKey', targetId: key.id });
  created(res, { id: key.id, name: key.name, role: key.role, key: secret }); // shown exactly once
}));

apiKeysRouter.delete('/:keyId', validate({ params: orgParam.extend({ keyId: z.string().max(40) }) }), guard('apikeys:manage'), h(async (req, res) => {
  const r = await prisma.apiKey.updateMany({ where: { id: req.params.keyId, orgId: req.org.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) throw AppError.notFound('API key not found');
  await audit(req, 'apikey.revoke', { targetType: 'apiKey', targetId: req.params.keyId }); ok(res, {});
}));
