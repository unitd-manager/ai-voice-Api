// Contract every voice provider adapter implements. Services depend on this, never on Vapi directly.
export const VOICE_PROVIDER_METHODS = ['createAssistant', 'updateAssistant', 'deleteAssistant', 'startOutboundCall', 'endCall', 'getCall', 'parseWebhook', 'verifyWebhook', 'createPhoneNumber', 'deletePhoneNumber', 'buildAssistant'];
export function assertProvider(p) {
  for (const m of VOICE_PROVIDER_METHODS) if (typeof p[m] !== 'function') throw new Error(`Voice provider missing method: ${m}`);
  return p;
}
