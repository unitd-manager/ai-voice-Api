import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { ok } from '../../core/response/respond.js';
import { runTurn } from './conversation.service.js';
import { forget } from './memory.service.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';

const orgP = z.object({ orgId: z.string().max(40) });
const agentP = orgP.extend({ agentId: z.string().max(40) });
export const conversationRouter = Router({ mergeParams: true });
conversationRouter.post('/:agentId/chat', validate({ params: agentP, body: z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) })).min(1).max(40), contact: z.string().max(40).optional() }) }), guard('calls:write'), h(async (req, res) =>
  ok(res, await runTurn({ orgId: req.org.id, agentId: req.params.agentId, messages: req.body.messages, contact: req.body.contact, usageKey: `chat:${req.id}` }))));
// Privacy: erase everything remembered about a caller.
conversationRouter.delete('/:agentId/memory', validate({ params: agentP, body: z.object({ contact: z.string().min(5).max(40) }) }), guard('agents:write'), h(async (req, res) => {
  const a = await prisma.agent.findFirst({ where: { id: req.params.agentId, orgId: req.org.id } });
  if (!a) throw AppError.notFound('Agent not found');
  ok(res, { deleted: (await forget(req.org.id, a.id, req.body.contact)).count });
}));
