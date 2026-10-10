import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { authRepository as repo } from './auth.repository.js';
import { AppError } from '../../core/errors/app-error.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../../core/security/crypto.js';
import { signAccessToken } from '../../core/security/tokens.js';
import { sendEmail } from '../../platform-services/email/email.service.js';
import { env } from '../../core/config/env.js';

const REFRESH_TTL_MS = 30 * 24 * 3600e3;
const slugify = (s) => `${s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org'}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
// Real bcrypt hash of a random string, used to equalise timing when the email is unknown.
const DUMMY_HASH = bcrypt.hashSync(randomToken(), 12);

async function issueTokens(user, meta, familyId = randomUUID()) {
  const refreshToken = randomToken(48);
  await repo.createSession({ userId: user.id, familyId, tokenHash: sha256(refreshToken), userAgent: meta.userAgent?.slice(0, 255), ip: meta.ip, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) });
  return { accessToken: signAccessToken(user.id), refreshToken, expiresIn: 900 };
}

async function oneTimeToken(userId, type, ttlMs) {
  const token = randomToken(32);
  await repo.createAuthToken({ userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
}

export const authService = {
  async register({ email, password, name, organizationName }, meta = {}) {
    if (await repo.findUserByEmail(email)) throw AppError.conflict('Email is already registered');
    const passwordHash = await hashPassword(password);
    const orgName = organizationName ?? `${name ?? email.split('@')[0]}'s workspace`;
    const { user, org } = await repo.createUserWithOrg({ email, passwordHash, name, orgName, slug: slugify(orgName) });
    const token = await oneTimeToken(user.id, 'EMAIL_VERIFY', 48 * 3600e3);
    await sendEmail({ to: email, subject: 'Verify your email', text: `${env.APP_URL}/verify-email?token=${token}` });
    return { user: { id: user.id, email: user.email, name: user.name }, organization: { id: org.id, name: org.name }, tokens: await issueTokens(user, meta) };
  },

  async login({ email, password }, meta = {}) {
    const user = await repo.findUserByEmail(email);
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid || user.disabledAt || user.deletedAt) throw AppError.unauthorized('Invalid email or password');
    return { user: { id: user.id, email: user.email, name: user.name, emailVerified: !!user.emailVerifiedAt }, tokens: await issueTokens(user, meta) };
  },

  async refresh({ refreshToken }, meta = {}) {
    const session = await repo.findSessionByHash(sha256(refreshToken));
    if (!session || session.revokedAt || session.expiresAt < new Date()) throw AppError.unauthorized('Invalid refresh token');
    if (session.rotatedAt) { // reuse of an already-rotated token ⇒ assume theft, kill the whole family
      await repo.revokeFamily(session.familyId);
      throw AppError.unauthorized('Refresh token reuse detected');
    }
    const { count } = await repo.markRotated(session.id);
    if (count !== 1) { await repo.revokeFamily(session.familyId); throw AppError.unauthorized('Refresh token reuse detected'); }
    const user = await repo.findUserById(session.userId);
    if (!user || user.disabledAt || user.deletedAt) throw AppError.unauthorized('Account unavailable');
    return issueTokens(user, meta, session.familyId);
  },

  async logout({ refreshToken }) {
    const session = await repo.findSessionByHash(sha256(refreshToken));
    if (session) await repo.revokeFamily(session.familyId);
  },

  async verifyEmail({ token }) {
    const rec = await repo.findAuthToken(sha256(token));
    if (!rec || rec.type !== 'EMAIL_VERIFY' || rec.usedAt || rec.expiresAt < new Date()) throw AppError.badRequest('Invalid or expired token');
    if ((await repo.consumeAuthToken(rec.id)).count !== 1) throw AppError.badRequest('Invalid or expired token');
    await repo.markEmailVerified(rec.userId);
    // Bootstrap: only a verified inbox owner can become platform admin.
    const u = await repo.findUserById(rec.userId);
    if (env.ADMIN_BOOTSTRAP_EMAIL && u?.email === env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase()) await repo.makePlatformAdmin(u.id);
  },

  // Always succeeds from the caller's perspective, to avoid account enumeration.
  async forgotPassword({ email }) {
    const user = await repo.findUserByEmail(email);
    if (!user || user.disabledAt) return;
    const token = await oneTimeToken(user.id, 'PASSWORD_RESET', 3600e3);
    await sendEmail({ to: email, subject: 'Reset your password', text: `${env.APP_URL}/reset-password?token=${token}` });
  },

  async resetPassword({ token, password }) {
    const rec = await repo.findAuthToken(sha256(token));
    if (!rec || rec.type !== 'PASSWORD_RESET' || rec.usedAt || rec.expiresAt < new Date()) throw AppError.badRequest('Invalid or expired token');
    if ((await repo.consumeAuthToken(rec.id)).count !== 1) throw AppError.badRequest('Invalid or expired token');
    await repo.setPassword(rec.userId, await hashPassword(password));
    await repo.revokeAllForUser(rec.userId);
  },
};
