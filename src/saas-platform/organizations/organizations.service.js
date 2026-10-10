import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { randomToken, sha256 } from '../../core/security/crypto.js';
import { ROLE_RANK } from '../../core/authorization/permissions.js';
import { sendEmail } from '../../platform-services/email/email.service.js';
import { env } from '../../core/config/env.js';

export const organizationsService = {
  listForUser: (userId) => prisma.membership.findMany({ where: { userId, org: { deletedAt: null } }, include: { org: { select: { id: true, name: true, slug: true } } } }),
  get: (orgId) => prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true, slug: true, settings: true, retentionDays: true, createdAt: true } }),
  update: (orgId, data) => prisma.organization.update({ where: { id: orgId }, data, select: { id: true, name: true, settings: true, retentionDays: true } }),
  listMembers: (orgId) => prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, email: true, name: true } } } }),

  async changeRole(org, actorRole, userId, role) {
    const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId: org } } });
    if (!m) throw AppError.notFound('Member not found');
    // Cannot touch someone of higher rank, nor grant a rank above your own.
    if (ROLE_RANK[m.role] > ROLE_RANK[actorRole] || ROLE_RANK[role] > ROLE_RANK[actorRole]) throw AppError.forbidden();
    if (m.role === 'OWNER' && role !== 'OWNER') await assertAnotherOwner(org, userId);
    return prisma.membership.update({ where: { id: m.id }, data: { role } });
  },
  async removeMember(org, actorRole, userId) {
    const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId: org } } });
    if (!m) throw AppError.notFound('Member not found');
    if (ROLE_RANK[m.role] > ROLE_RANK[actorRole]) throw AppError.forbidden();
    if (m.role === 'OWNER') await assertAnotherOwner(org, userId);
    await prisma.membership.delete({ where: { id: m.id } });
  },

  async invite(orgId, actorRole, invitedById, { email, role }) {
    if (ROLE_RANK[role] > ROLE_RANK[actorRole]) throw AppError.forbidden('Cannot invite above your own role');
    const token = randomToken(32);
    const inv = await prisma.invitation.create({ data: { orgId, email, role, invitedById, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 864e5) } });
    await sendEmail({ to: email, subject: 'You were invited', text: `${env.APP_URL}/accept-invite?token=${token}` });
    return { id: inv.id, email, role, expiresAt: inv.expiresAt };
  },
  async acceptInvite(userId, userEmail, token) {
    const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) } });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date() || inv.email.toLowerCase() !== userEmail.toLowerCase()) throw AppError.badRequest('Invalid or expired invitation');
    await prisma.$transaction([
      prisma.membership.upsert({ where: { userId_orgId: { userId, orgId: inv.orgId } }, update: {}, create: { userId, orgId: inv.orgId, role: inv.role } }),
      prisma.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
    ]);
    return { orgId: inv.orgId };
  },
};

async function assertAnotherOwner(orgId, excludeUserId) {
  const others = await prisma.membership.count({ where: { orgId, role: 'OWNER', userId: { not: excludeUserId } } });
  if (!others) throw AppError.conflict('An organization must keep at least one owner');
}
