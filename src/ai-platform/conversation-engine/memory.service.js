import { prisma } from '../../core/database/prisma.js';
import { env } from '../../core/config/env.js';
import { hmacSha256Hex } from '../../core/security/crypto.js';
import { redactPII } from '../guardrails/guardrails.js';

// Callers are keyed by a keyed hash of their number: the raw number is never stored in the memory table.
export const contactHash = (contact) => hmacSha256Hex(env.ENCRYPTION_KEY ?? env.JWT_REFRESH_SECRET, String(contact).replace(/[^\d+]/g, ''));
const MAX = 1500;

export async function getMemory(orgId, agentId, contact, now = new Date()) {
  if (!contact) return null;
  const m = await prisma.conversationMemory.findUnique({ where: { orgId_agentId_contactHash: { orgId, agentId, contactHash: contactHash(contact) } } });
  return m && m.expiresAt > now ? m.summary : null;
}
// Keeps the newest facts; retention comes from the agent version, else the organization default.
export async function remember({ orgId, agentId, contact, summary, retentionDays, now = new Date() }) {
  if (!contact || !summary) return;
  const key = { orgId_agentId_contactHash: { orgId, agentId, contactHash: contactHash(contact) } };
  const prev = await prisma.conversationMemory.findUnique({ where: key });
  const merged = `${redactPII(summary)}\n${prev && prev.expiresAt > now ? prev.summary : ''}`.trim().slice(0, MAX);
  const days = retentionDays ?? (await prisma.organization.findUnique({ where: { id: orgId }, select: { retentionDays: true } }))?.retentionDays ?? 90;
  const expiresAt = new Date(now.getTime() + days * 864e5);
  await prisma.conversationMemory.upsert({ where: key, create: { orgId, agentId, contactHash: contactHash(contact), summary: merged, expiresAt }, update: { summary: merged, expiresAt } });
}
export const forget = (orgId, agentId, contact) => prisma.conversationMemory.deleteMany({ where: { orgId, agentId, contactHash: contactHash(contact) } });
export const purgeExpiredMemory = (now = new Date()) => prisma.conversationMemory.deleteMany({ where: { expiresAt: { lt: now } } });
