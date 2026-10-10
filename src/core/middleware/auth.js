import { AppError } from '../errors/app-error.js';
import { verifyAccessToken } from '../security/tokens.js';
import { sha256 } from '../security/crypto.js';
import { can } from '../authorization/permissions.js';
import { prisma } from '../database/prisma.js';

// Authenticates a Bearer JWT (user) or an x-api-key (organization-scoped machine credential).
export async function authenticate(req, _res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string') {
      const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256(apiKey) } });
      if (!key || key.revokedAt) throw AppError.unauthorized('Invalid API key');
      req.auth = { type: 'apiKey', apiKeyId: key.id, orgId: key.orgId, role: key.role };
      prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
      return next();
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw AppError.unauthorized();
    const payload = verifyAccessToken(m[1]);
    req.auth = { type: 'user', userId: payload.sub };
    next();
  } catch (e) { next(e); }
}

// Cross-cutting hooks (e.g. API metering) registered by the app; run after the org context is resolved.
const orgHooks = [];
export const registerOrgHook = (fn) => orgHooks.push(fn);
const runHooks = (req, res, i = 0) => new Promise((resolve, reject) => (i >= orgHooks.length ? resolve() : orgHooks[i](req, res, (err) => (err ? reject(err) : runHooks(req, res, i + 1).then(resolve, reject)))));

// Resolves the caller's role in :orgId from the DATABASE. The org id in the URL is only a lookup key;
// access is granted solely by an existing membership (or an API key bound to that org).
export async function orgContext(req, _res, next) {
  try {
    const orgId = req.params.orgId;
    if (req.auth.type === 'apiKey') {
      if (req.auth.orgId !== orgId) throw AppError.notFound('Organization not found'); // no existence oracle
      const o = await prisma.organization.findUnique({ where: { id: orgId }, select: { deletedAt: true, suspendedAt: true } });
      if (o?.deletedAt) throw AppError.notFound('Organization not found');
      if (o?.suspendedAt) throw new AppError(403, 'ORG_SUSPENDED', 'This organization is suspended');
      req.org = { id: orgId, role: req.auth.role };
      await runHooks(req, _res);
      return next();
    }
    const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId: req.auth.userId, orgId } }, include: { org: { select: { deletedAt: true, suspendedAt: true } } } });
    if (!m || m.org.deletedAt) throw AppError.notFound('Organization not found');
    if (m.org.suspendedAt) throw new AppError(403, 'ORG_SUSPENDED', 'This organization is suspended');
    req.org = { id: orgId, role: m.role };
    await runHooks(req, _res);
    next();
  } catch (e) { next(e); }
}

export const requirePermission = (perm) => Object.assign((req, _res, next) =>
  can(req.org?.role, perm) ? next() : next(AppError.forbidden()), { permission: perm });

// Convenience: [authenticate, orgContext, permission]
export const guard = (perm) => [authenticate, orgContext, requirePermission(perm)];
