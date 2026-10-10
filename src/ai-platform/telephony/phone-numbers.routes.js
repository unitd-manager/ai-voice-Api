import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok, created } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { getVoiceProvider } from '../voice-engine/provider.factory.js';
import { assertWithinCount } from '../../saas-platform/entitlements/entitlements.service.js';
import { audit } from '../../saas-platform/audit-logs/audit.service.js';
import { serverConfig } from './inbound.service.js';

const orgP = z.object({ orgId: z.string().max(40) });
const idP = orgP.extend({ id: z.string().max(40) });
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/);
// Credentials for BYO carriers are passed straight to the provider and never stored by us.
const createBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('vapi'), areaCode: z.string().regex(/^\d{3}$/), monthlyCostMinor: z.number().int().min(0).max(100000).default(0) }),
  z.object({ provider: z.literal('twilio'), number: e164, twilioAccountSid: z.string().regex(/^AC[0-9a-f]{32}$/i), twilioAuthToken: z.string().min(16).max(64), monthlyCostMinor: z.number().int().min(0).max(100000).default(0) }),
]);

export const phoneNumbersRouter = Router({ mergeParams: true });
phoneNumbersRouter.get('/', validate({ params: orgP }), guard('agents:read'), h(async (req, res) => ok(res, await prisma.phoneNumber.findMany({ where: { orgId: req.org.id } }))));
phoneNumbersRouter.post('/', validate({ params: orgP, body: createBody }), guard('agents:write'), h(async (req, res) => {
  await assertWithinCount(req.org.id, 'phoneNumbers', await prisma.phoneNumber.count({ where: { orgId: req.org.id } }));
  const b = req.body;
  // No assistantId on purpose: Vapi asks OUR server per inbound call, so entitlements and caller memory apply.
  const payload = b.provider === 'vapi' ? { provider: 'vapi', numberDesiredAreaCode: b.areaCode, server: serverConfig() } : { provider: 'twilio', number: b.number, twilioAccountSid: b.twilioAccountSid, twilioAuthToken: b.twilioAuthToken, server: serverConfig() };
  const p = await getVoiceProvider().createPhoneNumber(payload);
  const number = p.number ?? b.number;
  if (!number) throw new AppError(502, 'PROVIDER_ERROR', 'Provider did not return a number');
  const row = await prisma.phoneNumber.create({ data: { orgId: req.org.id, e164: number, providerNumberId: p.id, monthlyCostMinor: b.monthlyCostMinor } });
  await audit(req, 'phone.create', { targetType: 'phoneNumber', targetId: row.id }); created(res, row);
}));
phoneNumbersRouter.patch('/:id', validate({ params: idP, body: z.object({ agentId: z.string().max(40).nullable() }) }), guard('agents:write'), h(async (req, res) => {
  const n = await prisma.phoneNumber.findFirst({ where: { id: req.params.id, orgId: req.org.id } });
  if (!n) throw AppError.notFound('Phone number not found');
  if (req.body.agentId) { const a = await prisma.agent.findFirst({ where: { id: req.body.agentId, orgId: req.org.id, deletedAt: null } }); if (!a) throw AppError.notFound('Agent not found'); }
  ok(res, await prisma.phoneNumber.update({ where: { id: n.id }, data: { agentId: req.body.agentId } }));
}));
phoneNumbersRouter.delete('/:id', validate({ params: idP }), guard('agents:write'), h(async (req, res) => {
  const n = await prisma.phoneNumber.findFirst({ where: { id: req.params.id, orgId: req.org.id } });
  if (!n) throw AppError.notFound('Phone number not found');
  if (n.providerNumberId) await getVoiceProvider().deletePhoneNumber(n.providerNumberId);
  await prisma.phoneNumber.delete({ where: { id: n.id } });
  await audit(req, 'phone.delete', { targetType: 'phoneNumber', targetId: n.id }); ok(res, {});
}));
