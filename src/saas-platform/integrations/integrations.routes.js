import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { audit } from '../audit-logs/audit.service.js';
import { PROVIDERS, saveIntegration } from './integrations.service.js';
import { decryptJson } from '../../core/security/encryption.js';

const orgP = z.object({ orgId: z.string().max(40) });
const provP = orgP.extend({ provider: z.enum(Object.keys(PROVIDERS)) });
export const integrationsRouter = Router({ mergeParams: true });
integrationsRouter.get('/', validate({ params: orgP }), guard('integrations:manage'), h(async (req, res) => {
  const rows = await prisma.integration.findMany({ where: { orgId: req.org.id }, select: { provider: true, enabled: true, createdAt: true } }); // credentials never returned
  ok(res, { available: Object.keys(PROVIDERS), configured: rows });
}));
integrationsRouter.put('/:provider', validate({ params: provP, body: z.object({ config: z.record(z.any()), enabled: z.boolean().default(true) }) }), guard('integrations:manage'), h(async (req, res) => {
  const cfg = PROVIDERS[req.params.provider].configSchema.parse(req.body.config);
  await saveIntegration(req.org.id, req.params.provider, cfg, req.body.enabled);
  await audit(req, 'integration.save', { targetType: 'integration', targetId: req.params.provider }); ok(res, {});
}));
integrationsRouter.post('/:provider/test', validate({ params: provP }), guard('integrations:manage'), h(async (req, res) => {
  const row = await prisma.integration.findUnique({ where: { orgId_provider: { orgId: req.org.id, provider: req.params.provider } } });
  if (!row?.credentialsEnc) throw AppError.notFound('Integration not configured');
  const p = PROVIDERS[req.params.provider];
  const r = await p.send(decryptJson(row.credentialsEnc), p.format('call.analyzed', { analysis: { outcome: 'test', customerIntent: 'connection test', summary: 'Test message from Voice Agent SaaS' } }));
  ok(res, { delivered: r.ok });
}));
integrationsRouter.delete('/:provider', validate({ params: provP }), guard('integrations:manage'), h(async (req, res) => {
  await prisma.integration.deleteMany({ where: { orgId: req.org.id, provider: req.params.provider } }); ok(res, {});
}));
