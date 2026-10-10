import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { safeFetch } from '../../core/security/ssrf.js';
import { TOOL_KINDS, toolResultSchema } from './tool-kinds.js';
import { decryptJson } from '../../core/security/encryption.js';
import { recordUsage } from '../../saas-platform/usage-metering/usage.service.js';
import { redactPII } from '../guardrails/guardrails.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Executes a tool on behalf of an agent. Authorization: the tool must belong to the org, be enabled,
// and be explicitly attached to the agent. Everything is logged to ToolExecution.
export async function executeTool({ orgId, agentId, toolName, rawArgs, callId = null }) {
  const tool = await prisma.toolDefinition.findFirst({ where: { orgId, name: toolName, enabled: true, agents: { some: { agentId, agent: { orgId } } } } });
  const log = async (status, extra = {}) => {
    const row = await prisma.toolExecution.create({ data: { orgId, callId, toolId: tool.id, status, ...extra } });
    if (row?.id) await recordUsage({ orgId, metric: 'TOOL_EXECUTIONS', quantity: 1, idempotencyKey: `tool:${row.id}`, callId }).catch(() => {});
    return row;
  };
  if (!tool) throw new AppError(403, 'TOOL_DENIED', 'Tool not available to this agent');
  const kind = TOOL_KINDS[tool.kind];
  if (!kind) throw new AppError(500, 'TOOL_MISCONFIGURED', 'Unknown tool kind');

  const parsed = kind.args.safeParse(rawArgs);
  if (!parsed.success) { await log('DENIED', { args: redactObj(rawArgs), error: 'invalid_arguments' }); throw AppError.badRequest('Invalid tool arguments', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))); }

  const { url, headersEnc, allowedHosts } = tool.config ?? {};
  const headers = headersEnc ? decryptJson(headersEnc) : {};
  const started = Date.now();
  const attempts = kind.idempotent ? 3 : 1; // only retry reads; never replay a write
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      let target = url; const init = { method: kind.method, headers: { Accept: 'application/json', ...headers } };
      if (kind.method === 'GET') { const u = new URL(url); for (const [k, v] of Object.entries(parsed.data)) u.searchParams.set(k, String(v)); target = u.toString(); }
      else { init.body = JSON.stringify(parsed.data); init.headers['Content-Type'] = 'application/json'; }
      const res = await safeFetch(target, { ...init, allowedHosts, timeoutMs: 8000 });
      if (!res.ok) throw new Error(`upstream_${res.status}`);
      const result = toolResultSchema.parse(JSON.parse(res.text));
      await log('SUCCESS', { args: redactObj(parsed.data), result: redactObj(result), durationMs: Date.now() - started });
      return result;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(200 * 2 ** i);
    }
  }
  const timeout = /abort|timeout/i.test(String(lastErr?.name + lastErr?.message));
  await log(timeout ? 'TIMEOUT' : 'FAILED', { args: redactObj(parsed.data), error: String(lastErr?.message).slice(0, 200), durationMs: Date.now() - started });
  throw new AppError(502, 'TOOL_FAILED', 'Tool execution failed');
}
const redactObj = (o) => JSON.parse(redactPII(JSON.stringify(o ?? {})));
