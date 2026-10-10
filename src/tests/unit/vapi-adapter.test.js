import { describe, it, expect, vi } from 'vitest';
import { createVapiAdapter, toVapiAssistant } from '../../ai-platform/voice-engine/vapi.adapter.js';
import { assertProvider } from '../../ai-platform/voice-engine/provider.interface.js';

const cfg = { systemPrompt: 'Be nice', greeting: 'Hi', language: 'en', model: { name: 'gpt-4o-mini', temperature: 0.2, maxTokens: 300 }, maxCallDurationSeconds: 600, silenceTimeoutSeconds: 20 };
const mkRes = (status, body) => ({ ok: status < 400, status, json: async () => body });

describe('Vapi adapter', () => {
  it('satisfies the provider interface', () => expect(() => assertProvider(createVapiAdapter({ apiKey: 'k' }))).not.toThrow());
  it('maps config to a Vapi assistant payload', () => {
    const a = toVapiAssistant({ name: 'Agent', config: cfg, agentId: 'a1' });
    expect(a.firstMessage).toBe('Hi'); expect(a.model.messages[0].content).toBe('Be nice'); expect(a.maxDurationSeconds).toBe(600);
  });
  it('sends bearer auth and returns the created assistant', async () => {
    const f = vi.fn().mockResolvedValue(mkRes(201, { id: 'asst_1' }));
    const r = await createVapiAdapter({ apiKey: 'K', fetchImpl: f }).createAssistant({ name: 'A', config: cfg, agentId: 'a' });
    expect(r.id).toBe('asst_1'); expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer K');
  });
  it('maps provider 5xx to 502 and 4xx to 400 without leaking details', async () => {
    const bad = createVapiAdapter({ apiKey: 'K', fetchImpl: vi.fn().mockResolvedValue(mkRes(500, {})) });
    await expect(bad.getCall('c')).rejects.toMatchObject({ statusCode: 502, code: 'PROVIDER_ERROR' });
    const rej = createVapiAdapter({ apiKey: 'K', fetchImpl: vi.fn().mockResolvedValue(mkRes(422, {})) });
    await expect(rej.getCall('c')).rejects.toMatchObject({ statusCode: 400 });
  });
  it('maps network failure to PROVIDER_UNAVAILABLE', async () => {
    const a = createVapiAdapter({ apiKey: 'K', fetchImpl: vi.fn().mockRejectedValue(new Error('ECONNRESET')) });
    await expect(a.getCall('c')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
  it('reports unconfigured provider clearly', async () => {
    await expect(createVapiAdapter({}).getCall('c')).rejects.toMatchObject({ statusCode: 503, code: 'PROVIDER_NOT_CONFIGURED' });
  });
  it('verifies webhook secret in constant time and rejects wrong/missing', () => {
    const a = createVapiAdapter({ webhookSecret: 'abc' });
    expect(a.verifyWebhook({ 'x-vapi-secret': 'abc' })).toBe(true);
    expect(a.verifyWebhook({ 'x-vapi-secret': 'abd' })).toBe(false);
    expect(a.verifyWebhook({})).toBe(false);
    expect(createVapiAdapter({}).verifyWebhook({ 'x-vapi-secret': 'x' })).toBe(false); // no secret configured ⇒ never trust
  });
  it('normalizes end-of-call-report', () => {
    const e = createVapiAdapter({}).parseWebhook({ message: { type: 'end-of-call-report', endedReason: 'hangup', durationSeconds: 61, cost: 0.12, call: { id: 'pc_1' } } });
    expect(e).toMatchObject({ type: 'end-of-call-report', providerCallId: 'pc_1' }); expect(e.data.durationSeconds).toBe(61);
  });
  it('rejects unrecognized payloads', () => expect(() => createVapiAdapter({}).parseWebhook({})).toThrow());
});
