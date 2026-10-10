import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';

// Fake OpenAI-compatible server: deterministic bag-of-words embeddings (dim 64) and canned chat completions.
const DIM = 64;
const hash = (w) => { let h = 2166136261; for (const c of w) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h) % DIM; };
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'of', 'to', 'for', 'and', 'in', 'on', 'how', 'what', 'do', 'i', 'my', 'our', 'we', 'it', 'all']);
export const embed = (t) => { const v = new Array(DIM).fill(0); for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (!STOP.has(w)) v[hash(w)] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const state = { failPrimary: false, chatCalls: [] };

let provider, s3;
export async function setup() {
  provider = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/control') return send(200, (Object.assign(state, j), state));
    if (req.url === '/v1/embeddings') return send(200, { data: j.input.map((t, index) => ({ index, embedding: embed(t) })), usage: { total_tokens: j.input.length * 5 } });
    if (req.url === '/v1/chat/completions') {
      state.chatCalls.push(j.model);
      if (state.failPrimary && j.model === 'primary') return send(503, { error: 'overloaded' });
      const content = JSON.stringify({ summary: 'Caller asked about refunds', outcome: 'resolved', customerIntent: 'refund policy', actionItems: ['send policy'], leadQualification: 'warm', sentiment: 'positive', qualityScore: 9, extracted: {} });
      return send(200, { choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 77 } });
    }
    send(404, {});
  });
  await new Promise((r) => provider.listen(18089, '127.0.0.1', r));
  s3 = new S3rver({ port: 14566, address: '127.0.0.1', silent: true, directory: mkdtempSync(join(tmpdir(), 's3-')), configureBuckets: [{ name: 'test-bucket' }] });
  await s3.run();
}
export async function teardown() { provider?.close(); await s3?.close(); }
