import { describe, it, expect } from 'vitest';
// These talk to REAL services and may cost money. Each block skips itself unless its credentials are present.
const live = process.env.LIVE_TESTS === '1';
const has = (...k) => live && k.every((x) => process.env[x]);

describe.skipIf(!has('VAPI_API_KEY'))('Vapi (live)', () => {
  it('creates, updates and deletes an assistant using our payload mapping', async () => {
    const { createVapiAdapter } = await import('../../ai-platform/voice-engine/vapi.adapter.js');
    const a = createVapiAdapter({ apiKey: process.env.VAPI_API_KEY });
    const cfg = { systemPrompt: 'You are a test assistant.', greeting: 'Hi', model: { name: 'gpt-4o-mini', temperature: 0.2, maxTokens: 100 }, maxCallDurationSeconds: 60, silenceTimeoutSeconds: 10, transferRules: [] };
    const created = await a.createAssistant({ name: 'live-test', config: cfg, agentId: 'live', functions: [], server: { url: 'https://example.com/hook' } });
    expect(created.id).toBeTruthy();
    await a.updateAssistant(created.id, { name: 'live-test-2', config: cfg, agentId: 'live' });
    await a.deleteAssistant(created.id);
  });
});
describe.skipIf(!has('EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY'))('Embeddings (live)', () => {
  it('returns vectors of the configured dimension', async () => {
    const { embedTexts } = await import('../../ai-platform/embeddings/embeddings.service.js');
    const { env } = await import('../../core/config/env.js');
    const { vectors, tokens } = await embedTexts(['hello world']);
    expect(vectors[0].length).toBe(env.EMBEDDING_DIM); expect(tokens).toBeGreaterThan(0);
  });
});
describe.skipIf(!has('QDRANT_URL', 'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY'))('Qdrant + RAG (live)', () => {
  it('indexes a chunk and retrieves it only for the owning org', async () => {
    const { vectorStore } = await import('../../ai-platform/vector-store/qdrant.client.js');
    const { embedTexts } = await import('../../ai-platform/embeddings/embeddings.service.js');
    const { randomUUID } = await import('node:crypto');
    await vectorStore.ensureCollection(); const doc = randomUUID(); const org = `live-${doc}`;
    const { vectors } = await embedTexts(['Our refund window is 30 days.']); await vectorStore.upsert([{ id: randomUUID(), vector: vectors[0], payload: { orgId: org, knowledgeBaseId: 'kb', documentId: doc, text: 'Our refund window is 30 days.' } }]);
    const { vectors: q } = await embedTexts(['How long do I have to get a refund?']);
    expect((await vectorStore.search(q[0], { orgId: org, knowledgeBaseIds: ['kb'], limit: 3 })).length).toBeGreaterThan(0);
    expect(await vectorStore.search(q[0], { orgId: 'someone-else', knowledgeBaseIds: ['kb'], limit: 3 })).toEqual([]);
    await vectorStore.deleteByDocument(org, doc);
  });
});
describe.skipIf(!has('LLM_BASE_URL', 'LLM_API_KEY'))('LLM (live)', () => {
  it('chatJson returns parseable JSON with token usage', async () => {
    const { chatJson } = await import('../../ai-platform/llm-orchestration/llm.client.js');
    const r = await chatJson({ system: 'Reply with JSON {"ok":true}', user: 'go', maxTokens: 20 }); expect(JSON.parse(r.content).ok).toBe(true); expect(r.tokens).toBeGreaterThan(0);
  });
});
