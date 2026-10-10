import { env } from '../../core/config/env.js';
import { AppError } from '../../core/errors/app-error.js';

export async function embedTexts(texts, { fetchImpl = fetch } = {}) {
  if (!env.EMBEDDING_BASE_URL || !env.EMBEDDING_API_KEY) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Embedding provider is not configured');
  const out = []; let tokens = 0;
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const res = await fetchImpl(`${env.EMBEDDING_BASE_URL.replace(/\/$/, '')}/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${env.EMBEDDING_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: batch }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new AppError(502, 'PROVIDER_ERROR', `Embedding provider error (${res.status})`);
    const j = await res.json();
    for (const d of j.data.sort((a, b) => a.index - b.index)) out.push(d.embedding);
    tokens += j.usage?.total_tokens ?? 0;
  }
  return { vectors: out, tokens };
}
