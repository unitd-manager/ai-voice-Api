import { Router } from 'express';
import { asyncHandler as h } from '../../../core/middleware/async-handler.js';
import { AppError } from '../../../core/errors/app-error.js';
import { getVoiceProvider } from '../../../ai-platform/voice-engine/provider.factory.js';
import { callsService } from '../../../ai-platform/calls/calls.service.js';
import { handleServerRequest } from '../../../ai-platform/telephony/inbound.service.js';
import { receiveWebhook } from '../webhook-inbox.js';

const REQUEST_RESPONSE = new Set(['assistant-request', 'tool-calls', 'transfer-destination-request']);

export const vapiWebhookRouter = Router();
vapiWebhookRouter.post('/', h(async (req, res) => {
  const provider = getVoiceProvider();
  if (!provider.verifyWebhook(req.headers)) throw AppError.unauthorized('Invalid webhook signature'); // verify BEFORE parsing/persisting
  const evt = provider.parseWebhook(req.body);
  // Live request/response messages block a phone call: answer directly, do not persist/queue them.
  if (REQUEST_RESPONSE.has(evt.type)) return res.status(200).json(await handleServerRequest(evt, req.body.message));
  await receiveWebhook({ source: 'vapi', externalId: evt.externalId.slice(0, 190), type: evt.type, payload: req.body }, () => callsService.applyProviderEvent(evt));
  res.status(200).json({ success: true, data: {}, meta: {} });
}));
