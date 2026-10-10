import { env } from '../../core/config/env.js';
import { createVapiAdapter } from './vapi.adapter.js';
import { assertProvider } from './provider.interface.js';

let override;
export const setVoiceProviderForTests = (p) => { override = p; };
export function getVoiceProvider() {
  return override ?? assertProvider(createVapiAdapter({ apiKey: env.VAPI_API_KEY, webhookSecret: env.VAPI_WEBHOOK_SECRET }));
}
