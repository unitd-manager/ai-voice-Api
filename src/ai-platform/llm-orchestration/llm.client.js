import { env } from '../../core/config/env.js';
import { AppError } from '../../core/errors/app-error.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// OpenAI-compatible chat call with timeout, retry on 429/5xx, and fallback model.
export async function chatJson({ system, user, maxTokens = 800, fetchImpl = fetch }) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'LLM provider is not configured');
  const models = [env.LLM_MODEL, env.LLM_FALLBACK_MODEL].filter(Boolean);
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(`${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`llm_${res.status}`), { retry: true });
        if (!res.ok) throw new AppError(502, 'PROVIDER_ERROR', `LLM error (${res.status})`);
        const j = await res.json();
        return { content: j.choices?.[0]?.message?.content ?? '', tokens: j.usage?.total_tokens ?? 0, model };
      } catch (e) { lastErr = e; if (!e.retry && !/abort|timeout|fetch/i.test(e.message ?? '')) break; await sleep(500 * 2 ** attempt); }
    }
  }
  throw lastErr ?? new AppError(502, 'PROVIDER_ERROR', 'LLM unavailable');
}

// General chat completion (optionally with function tools). Retries 429/5xx/timeouts per model, then falls back.
export async function chat({ messages, tools, model, maxTokens = 500, temperature = 0.3, fetchImpl = fetch, sleepImpl = sleep }) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'LLM provider is not configured');
  const models = [model ?? env.LLM_MODEL, env.LLM_FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr;
  for (const m of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(`${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ model: m, messages, max_tokens: maxTokens, temperature, ...(tools?.length ? { tools: tools.map((f) => ({ type: 'function', function: f })) } : {}) }) });
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`llm_${res.status}`), { retry: true });
        if (!res.ok) throw new AppError(502, 'PROVIDER_ERROR', `LLM error (${res.status})`);
        const j = await res.json(); const msg = j.choices?.[0]?.message;
        if (!msg) throw new AppError(502, 'PROVIDER_ERROR', 'Empty LLM response');
        return { message: msg, tokens: j.usage?.total_tokens ?? 0, model: m };
      } catch (e) { lastErr = e; if (!e.retry && !/abort|timeout|fetch/i.test(e.message ?? '')) throw e; await sleepImpl(300 * 2 ** attempt); }
    }
  }
  throw lastErr ?? new AppError(502, 'PROVIDER_ERROR', 'LLM unavailable');
}
