import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { idempotent } from '../../core/middleware/idempotency.js';
import { ok, created } from '../../core/response/respond.js';
import { pageQuery, paginate } from '../../core/utils/pagination.js';
import { callsService as svc } from './calls.service.js';

const orgP = z.object({ orgId: z.string().max(40) });
const callP = orgP.extend({ callId: z.string().max(40) });
export const callsRouter = Router({ mergeParams: true });
callsRouter.get('/', validate({ params: orgP, query: pageQuery.extend({ status: z.enum(['QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY', 'CANCELED']).optional(), agentId: z.string().max(40).optional() }) }), guard('calls:read'), h(async (req, res) => {
  const { items, meta } = paginate(await svc.list(req.org.id, { take: req.query.limit, cursor: req.query.cursor, status: req.query.status, agentId: req.query.agentId }), req.query.limit); ok(res, items, meta);
}));
callsRouter.post('/outbound', validate({ params: orgP, body: z.object({ agentId: z.string().max(40), phoneNumberId: z.string().max(40), toNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 format required') }) }), guard('calls:write'), idempotent, h(async (req, res) => created(res, await svc.startOutbound(req.org.id, req.body))));
callsRouter.get('/:callId', validate({ params: callP }), guard('calls:read'), h(async (req, res) => ok(res, await svc.get(req.org.id, req.params.callId))));
callsRouter.post('/:callId/terminate', validate({ params: callP }), guard('calls:write'), h(async (req, res) => ok(res, await svc.terminate(req.org.id, req.params.callId))));
