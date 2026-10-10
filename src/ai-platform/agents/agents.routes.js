import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok, created } from '../../core/response/respond.js';
import { pageQuery, paginate } from '../../core/utils/pagination.js';
import { audit } from '../../saas-platform/audit-logs/audit.service.js';
import { agentsService as svc } from './agents.service.js';
import { createAgentBody, updateAgentBody, agentParams } from './agents.validation.js';

const orgP = z.object({ orgId: z.string().max(40) });
export const agentsRouter = Router({ mergeParams: true });

agentsRouter.get('/', validate({ params: orgP, query: pageQuery.extend({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional() }) }), guard('agents:read'), h(async (req, res) => {
  const { items, meta } = paginate(await svc.list(req.org.id, { take: req.query.limit, cursor: req.query.cursor, status: req.query.status }), req.query.limit); ok(res, items, meta);
}));
agentsRouter.post('/', validate({ params: orgP, body: createAgentBody }), guard('agents:write'), h(async (req, res) => {
  const a = await svc.create(req.org.id, req.auth.userId ?? null, req.body); await audit(req, 'agent.create', { targetType: 'agent', targetId: a.id }); created(res, a);
}));
agentsRouter.get('/:agentId', validate({ params: agentParams }), guard('agents:read'), h(async (req, res) => ok(res, await svc.get(req.org.id, req.params.agentId))));
agentsRouter.patch('/:agentId', validate({ params: agentParams, body: updateAgentBody }), guard('agents:write'), h(async (req, res) => {
  const a = await svc.update(req.org.id, req.params.agentId, req.auth.userId ?? null, req.body); await audit(req, 'agent.update', { targetType: 'agent', targetId: a.id }); ok(res, a);
}));
agentsRouter.get('/:agentId/versions', validate({ params: agentParams }), guard('agents:read'), h(async (req, res) => ok(res, await svc.versions(req.org.id, req.params.agentId))));
agentsRouter.post('/:agentId/rollback', validate({ params: agentParams, body: z.object({ version: z.number().int().positive() }) }), guard('agents:write'), h(async (req, res) => ok(res, await svc.rollback(req.org.id, req.params.agentId, req.auth.userId ?? null, req.body.version))));
agentsRouter.post('/:agentId/publish', validate({ params: agentParams }), guard('agents:write'), h(async (req, res) => { const a = await svc.publish(req.org.id, req.params.agentId); await audit(req, 'agent.publish', { targetType: 'agent', targetId: a.id }); ok(res, a); }));
agentsRouter.post('/:agentId/archive', validate({ params: agentParams }), guard('agents:write'), h(async (req, res) => ok(res, await svc.archive(req.org.id, req.params.agentId))));
agentsRouter.post('/:agentId/duplicate', validate({ params: agentParams }), guard('agents:write'), h(async (req, res) => created(res, await svc.duplicate(req.org.id, req.params.agentId, req.auth.userId ?? null))));
agentsRouter.delete('/:agentId', validate({ params: agentParams }), guard('agents:write'), h(async (req, res) => { await svc.remove(req.org.id, req.params.agentId); await audit(req, 'agent.delete', { targetType: 'agent', targetId: req.params.agentId }); ok(res, {}); }));
