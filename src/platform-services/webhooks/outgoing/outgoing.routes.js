import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../../core/middleware/async-handler.js';
import { validate } from '../../../core/middleware/validate.js';
import { guard } from '../../../core/middleware/auth.js';
import { ok, created } from '../../../core/response/respond.js';
import { prisma } from '../../../core/database/prisma.js';
import { AppError } from '../../../core/errors/app-error.js';
import { assertSafeUrlSyntax } from '../../../core/security/ssrf.js';
import { randomToken } from '../../../core/security/crypto.js';
import { encrypt } from '../../../core/security/encryption.js';

const orgP = z.object({ orgId: z.string().max(40) });
export const outgoingWebhooksRouter = Router({ mergeParams: true });
outgoingWebhooksRouter.get('/', validate({ params: orgP }), guard('webhooks:manage'), h(async (req, res) => ok(res, await prisma.webhookEndpoint.findMany({ where: { orgId: req.org.id }, select: { id: true, url: true, events: true, enabled: true, createdAt: true } }))));
outgoingWebhooksRouter.post('/', validate({ params: orgP, body: z.object({ url: z.string().url().max(500), events: z.array(z.enum(['*', 'call.completed', 'call.analyzed', 'document.ready'])).min(1).max(10) }) }), guard('webhooks:manage'), h(async (req, res) => {
  assertSafeUrlSyntax(req.body.url);
  const secret = `whsec_${randomToken(24)}`;
  const ep = await prisma.webhookEndpoint.create({ data: { orgId: req.org.id, url: req.body.url, events: req.body.events, secret: encrypt(secret) } });
  created(res, { id: ep.id, url: ep.url, events: ep.events, secret }); // secret shown once
}));
outgoingWebhooksRouter.delete('/:id', validate({ params: orgP.extend({ id: z.string().max(40) }) }), guard('webhooks:manage'), h(async (req, res) => {
  const r = await prisma.webhookEndpoint.deleteMany({ where: { id: req.params.id, orgId: req.org.id } });
  if (!r.count) throw AppError.notFound('Webhook not found'); ok(res, {});
}));
