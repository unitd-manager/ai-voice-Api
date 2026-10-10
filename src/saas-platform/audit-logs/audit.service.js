import { prisma } from '../../core/database/prisma.js';
import { logger } from '../../core/logging/logger.js';

// Audit writes must never break the primary operation, but failures are logged loudly.
export async function audit(req, action, { targetType, targetId, metadata } = {}) {
  try {
    await prisma.auditLog.create({ data: { orgId: req.org?.id ?? null, actorId: req.auth?.userId ?? req.auth?.apiKeyId ?? null, action, targetType, targetId, metadata, ip: req.ip } });
  } catch (err) { logger.error({ err, action }, 'audit log write failed'); }
}
export const listAudit = (orgId, { take, cursor }) =>
  prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: take + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
