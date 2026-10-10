import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { guard } from '../../core/middleware/auth.js';
import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { storage } from '../../platform-services/storage/storage.service.js';
import { audit } from '../../saas-platform/audit-logs/audit.service.js';

export const recordingsRouter = Router({ mergeParams: true });
// Streams via the API (auth + tenant check + audit) rather than exposing a permanent public URL.
recordingsRouter.get('/:callId', validate({ params: z.object({ orgId: z.string().max(40), callId: z.string().max(40) }) }), guard('recordings:read'), h(async (req, res) => {
  const rec = await prisma.recording.findFirst({ where: { callId: req.params.callId, orgId: req.org.id, deletedAt: null } });
  if (!rec) throw AppError.notFound('Recording not found');
  await audit(req, 'recording.access', { targetType: 'call', targetId: req.params.callId });
  res.setHeader('Content-Type', rec.contentType); res.setHeader('Cache-Control', 'private, no-store'); res.send(await storage.get(rec.storageKey));
}));
