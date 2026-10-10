import { prisma } from '../../core/database/prisma.js';

export const authRepository = {
  findUserByEmail: (email) => prisma.user.findUnique({ where: { email } }),
  findUserById: (id) => prisma.user.findUnique({ where: { id } }),
  // User + org + owner membership must succeed or fail together.
  createUserWithOrg: ({ email, passwordHash, name, orgName, slug }) =>
    prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, passwordHash, name } });
      const org = await tx.organization.create({ data: { name: orgName, slug } });
      await tx.membership.create({ data: { userId: user.id, orgId: org.id, role: 'OWNER' } });
      const trial = await tx.plan.findUnique({ where: { code: 'trial' } }); // seeded plan; absent in unseeded DBs
      if (trial) { const now = new Date(); const end = new Date(now.getTime() + 14 * 864e5); await tx.subscription.create({ data: { orgId: org.id, planId: trial.id, status: 'TRIALING', interval: 'MONTH', currentPeriodStart: now, currentPeriodEnd: end, trialEndsAt: end } }); }
      return { user, org };
    }),
  createSession: (data) => prisma.session.create({ data }),
  findSessionByHash: (tokenHash) => prisma.session.findUnique({ where: { tokenHash } }),
  // Conditional update so two concurrent refreshes cannot both rotate the same token.
  markRotated: (id) => prisma.session.updateMany({ where: { id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: new Date() } }),
  revokeFamily: (familyId) => prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } }),
  revokeAllForUser: (userId) => prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  createAuthToken: (data) => prisma.authToken.create({ data }),
  findAuthToken: (tokenHash) => prisma.authToken.findUnique({ where: { tokenHash } }),
  consumeAuthToken: (id) => prisma.authToken.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } }),
  markEmailVerified: (id) => prisma.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } }),
  makePlatformAdmin: (id) => prisma.user.update({ where: { id }, data: { isPlatformAdmin: true } }),
  setPassword: (id, passwordHash) => prisma.user.update({ where: { id }, data: { passwordHash } }),
};
