import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok, created } from '../../core/response/respond.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { assertSafeUrlSyntax } from '../../core/security/ssrf.js';
import { toolKindEnum } from './tool-kinds.js';
import { encryptJson } from '../../core/security/encryption.js';
import { executeTool } from './tool-executor.js';
import { audit } from '../../saas-platform/audit-logs/audit.service.js';

const orgP = z.object({ orgId: z.string().max(40) });
const body = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), kind: toolKindEnum, description: z.string().min(1).max(500), config: z.object({ url: z.string().url().max(500), headers: z.record(z.string().max(500)).optional(), allowedHosts: z.array(z.string().max(253)).max(10).optional() }).strict(), enabled: z.boolean().default(true) });
export const toolsRouter = Router({ mergeParams: true });

toolsRouter.get('/', validate({ params: orgP }), guard('tools:read'), h(async (req, res) => ok(res, (await prisma.toolDefinition.findMany({ where: { orgId: req.org.id } })).map(({ config, ...t }) => ({ ...t, config: { url: config?.url } })))));  // headers (secrets) never returned
toolsRouter.post('/', validate({ params: orgP, body }), guard('tools:write'), h(async (req, res) => {
  assertSafeUrlSyntax(req.body.config.url, { allowedHosts: req.body.config.allowedHosts });
  const { kind, ...rest } = req.body;
  const t = await prisma.toolDefinition.create({ data: { orgId: req.org.id, kind, name: rest.name, description: rest.description, enabled: rest.enabled, paramsSchema: {}, config: { url: rest.config.url, allowedHosts: rest.config.allowedHosts, ...(rest.config.headers ? { headersEnc: encryptJson(rest.config.headers) } : {}) } } }).catch((e) => { if (e.code === 'P2002') throw AppError.conflict('Tool name already exists'); throw e; });
  await audit(req, 'tool.create', { targetType: 'tool', targetId: t.id }); created(res, { id: t.id, name: t.name, kind: t.kind });
}));
toolsRouter.delete('/:toolId', validate({ params: orgP.extend({ toolId: z.string().max(40) }) }), guard('tools:write'), h(async (req, res) => {
  const r = await prisma.toolDefinition.deleteMany({ where: { id: req.params.toolId, orgId: req.org.id } });
  if (!r.count) throw AppError.notFound('Tool not found'); ok(res, {});
}));
// Executes a tool as an agent would (used by the voice provider's server-side tool calls and for testing).
toolsRouter.post('/execute', validate({ params: orgP, body: z.object({ agentId: z.string().max(40), toolName: z.string().max(60), args: z.record(z.any()), callId: z.string().max(40).optional() }) }), guard('calls:write'), h(async (req, res) => {
  const agent = await prisma.agent.findFirst({ where: { id: req.body.agentId, orgId: req.org.id } });
  if (!agent) throw AppError.notFound('Agent not found');
  ok(res, await executeTool({ orgId: req.org.id, agentId: agent.id, toolName: req.body.toolName, rawArgs: req.body.args, callId: req.body.callId }));
}));
