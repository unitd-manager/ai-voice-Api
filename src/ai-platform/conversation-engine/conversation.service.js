import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { chat } from '../llm-orchestration/llm.client.js';
import { retrieve, buildContext } from '../rag/rag.service.js';
import { executeTool } from '../tool-calling/tool-executor.js';
import { toFunctionDefs } from '../tool-calling/tool-kinds.js';
import { getMemory } from './memory.service.js';
import { buildSystemPrompt, trimMessages } from './prompt.js';
import { looksLikePromptInjection } from '../guardrails/guardrails.js';
import { recordUsage } from '../../saas-platform/usage-metering/usage.service.js';
import { getEntitlements } from '../../saas-platform/entitlements/entitlements.service.js';

const MAX_TOOL_ROUNDS = 4;
const CONTEXT_BUDGET_TOKENS = 3000;

// One text turn of an agent: RAG → LLM → (tool calls → LLM)* → answer. Used for chat testing and as the
// reference implementation of the orchestration; live phone calls run on the voice provider with the same prompt/tools.
export async function runTurn({ orgId, agentId, messages, contact, usageKey }) {
  const ent = await getEntitlements(orgId);
  if (!ent.active) throw new AppError(402, 'SUBSCRIPTION_REQUIRED', 'An active subscription is required');
  const agent = await prisma.agent.findFirst({ where: { id: agentId, orgId, deletedAt: null }, include: { currentVersion: true } });
  if (!agent?.currentVersion) throw AppError.notFound('Agent not found');
  const config = agent.currentVersion.config;
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const flagged = last ? looksLikePromptInjection(last.content) : false;

  const [tools, kbCount, memory] = await Promise.all([
    prisma.agentTool.findMany({ where: { agentId, tool: { orgId, enabled: true } }, include: { tool: true } }),
    prisma.agentKnowledgeBase.count({ where: { agentId, kb: { orgId } } }),
    getMemory(orgId, agentId, contact),
  ]);
  let ragContext = null; let citations = [];
  if (kbCount && last) { const r = await retrieve({ orgId, agentId, query: last.content.slice(0, 500) }); ragContext = buildContext(r); citations = r.chunks.map((c) => c.citation); }

  const toolRows = tools.map((t) => t.tool);
  const functions = toFunctionDefs(toolRows, { withKnowledge: false });
  const convo = [{ role: 'system', content: buildSystemPrompt({ config, ragContext, memory }) }, ...trimMessages(messages, CONTEXT_BUDGET_TOKENS)];
  let tokens = 0; const toolTrace = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const r = await chat({ messages: convo, tools: functions, model: config.model?.name, maxTokens: config.model?.maxTokens, temperature: config.model?.temperature });
    tokens += r.tokens; convo.push(r.message);
    const calls = r.message.tool_calls ?? [];
    if (!calls.length) {
      if (usageKey) await recordUsage({ orgId, metric: 'LLM_TOKENS', quantity: tokens, idempotencyKey: usageKey });
      return { reply: r.message.content ?? '', tokens, model: r.model, citations, toolTrace, flaggedInjection: flagged };
    }
    if (round === MAX_TOOL_ROUNDS) break;
    for (const c of calls) {
      let content;
      try { content = JSON.stringify(await executeTool({ orgId, agentId, toolName: c.function.name, rawArgs: JSON.parse(c.function.arguments || '{}') })); toolTrace.push({ name: c.function.name, ok: true }); }
      catch { content = JSON.stringify({ error: 'The tool could not complete this request.' }); toolTrace.push({ name: c.function.name, ok: false }); }
      convo.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }
  throw new AppError(502, 'AGENT_LOOP_LIMIT', 'The agent could not complete the request');
}
