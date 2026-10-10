import { prisma } from '../../core/database/prisma.js';
import { logger } from '../../core/logging/logger.js';
import { getVoiceProvider } from '../voice-engine/provider.factory.js';
import { toFunctionDefs } from '../tool-calling/tool-kinds.js';
import { executeTool } from '../tool-calling/tool-executor.js';
import { retrieve, buildContext } from '../rag/rag.service.js';
import { getEntitlements } from '../../saas-platform/entitlements/entitlements.service.js';
import { getMemory } from '../conversation-engine/memory.service.js';
import { env } from '../../core/config/env.js';

export const serverConfig = () => ({ url: `${env.APP_URL}/api/v1/webhooks/vapi`, ...(env.VAPI_WEBHOOK_SECRET ? { secret: env.VAPI_WEBHOOK_SECRET } : {}) });

// Everything the provider needs to run an agent: prompt/config + function tools (business tools and knowledge search).
export async function assistantPayloadFor(agent, { memory } = {}) {
  const [tools, kbs] = await Promise.all([
    prisma.agentTool.findMany({ where: { agentId: agent.id, tool: { orgId: agent.orgId, enabled: true } }, include: { tool: true } }),
    prisma.agentKnowledgeBase.count({ where: { agentId: agent.id, kb: { orgId: agent.orgId } } }),
  ]);
  const functions = toFunctionDefs(tools.map((t) => t.tool), { withKnowledge: kbs > 0 });
  return { name: agent.name, config: agent.currentVersion.config, agentId: agent.id, functions, server: serverConfig(), memory };
}

// Finds our Call for a provider event, or (for inbound calls to one of OUR numbers) creates it.
export async function resolveCall(evt) {
  if (!evt.providerCallId) return null;
  const existing = await prisma.call.findUnique({ where: { providerCallId: evt.providerCallId } });
  if (existing) return existing;
  const ci = evt.callInfo ?? {};
  if (ci.direction !== 'INBOUND') return null;
  const number = await prisma.phoneNumber.findFirst({ where: { OR: [...(ci.phoneNumberId ? [{ providerNumberId: ci.phoneNumberId }] : []), ...(ci.ourNumber ? [{ e164: ci.ourNumber }] : [])] } });
  if (!number?.agentId) return null;
  const agent = await prisma.agent.findFirst({ where: { id: number.agentId, orgId: number.orgId, deletedAt: null } });
  if (!agent) return null;
  try {
    return await prisma.call.create({ data: { orgId: number.orgId, agentId: agent.id, agentVersionId: agent.currentVersionId, direction: 'INBOUND', status: 'IN_PROGRESS', providerCallId: evt.providerCallId, fromNumber: ci.customerNumber, toNumber: number.e164, startedAt: new Date() } });
  } catch (e) { if (e?.code === 'P2002') return prisma.call.findUnique({ where: { providerCallId: evt.providerCallId } }); throw e; }
}

// Responds to Vapi messages that need a body. Returns undefined for informational messages.
export async function handleServerRequest(evt, rawMessage) {
  if (evt.type === 'assistant-request') {
    const ci = evt.callInfo ?? {};
    const number = await prisma.phoneNumber.findFirst({ where: { OR: [...(ci.phoneNumberId ? [{ providerNumberId: ci.phoneNumberId }] : []), ...(rawMessage?.phoneNumber?.number ? [{ e164: rawMessage.phoneNumber.number }] : [])] } });
    if (!number?.agentId) return { error: 'This number is not configured.' };
    const ent = await getEntitlements(number.orgId);
    if (!ent.active) return { error: 'We are unable to take your call right now. Please try again later.' };
    const agent = await prisma.agent.findFirst({ where: { id: number.agentId, orgId: number.orgId, deletedAt: null, status: 'PUBLISHED' }, include: { currentVersion: true } });
    if (!agent?.currentVersion) return { error: 'This number is not configured.' };
    const memory = await getMemory(number.orgId, agent.id, ci.customerNumber);
    return { assistant: getVoiceProvider().buildAssistant(await assistantPayloadFor(agent, { memory })) };
  }
  if (evt.type === 'tool-calls') {
    const call = await resolveCall(evt);
    const results = [];
    for (const t of evt.toolCalls) {
      let result;
      try {
        if (!call) throw new Error('unknown_call');
        if (t.name === 'search_knowledge') {
          const q = typeof t.args === 'string' ? JSON.parse(t.args).query : t.args.query;
          result = buildContext(await retrieve({ orgId: call.orgId, agentId: call.agentId, query: String(q).slice(0, 500) }));
        } else {
          result = JSON.stringify(await executeTool({ orgId: call.orgId, agentId: call.agentId, toolName: t.name, rawArgs: typeof t.args === 'string' ? JSON.parse(t.args) : t.args, callId: call.id }));
        }
      } catch (err) {
        logger.warn({ tool: t.name, err: err.message }, 'tool call failed');
        result = JSON.stringify({ error: 'The tool could not complete this request.' }); // never leak internals to the model/caller
      }
      results.push({ name: t.name, toolCallId: t.id, result });
    }
    return { results };
  }
  if (evt.type === 'transfer-destination-request') {
    const call = await resolveCall(evt);
    const v = call && (await prisma.agentVersion.findUnique({ where: { id: call.agentVersionId ?? '' } }));
    const rule = v?.config?.transferRules?.[0];
    return rule ? { destination: { type: 'number', number: rule.phoneNumber } } : { error: 'Transfer is not available.' };
  }
  return undefined;
}
