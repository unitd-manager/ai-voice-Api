import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { getVoiceProvider } from '../voice-engine/provider.factory.js';
import { assistantPayloadFor } from '../telephony/inbound.service.js';

// Every query includes orgId: an agent id from another tenant is indistinguishable from a missing one.
const own = async (orgId, agentId, tx = prisma) => {
  const a = await tx.agent.findFirst({ where: { id: agentId, orgId, deletedAt: null }, include: { currentVersion: true } });
  if (!a) throw AppError.notFound('Agent not found');
  return a;
};
async function assertOwned(tx, orgId, kbIds = [], toolIds = []) {
  if (kbIds.length && (await tx.knowledgeBase.count({ where: { orgId, id: { in: kbIds } } })) !== kbIds.length) throw AppError.badRequest('Unknown knowledge base');
  if (toolIds.length && (await tx.toolDefinition.count({ where: { orgId, id: { in: toolIds } } })) !== toolIds.length) throw AppError.badRequest('Unknown tool');
}
async function setLinks(tx, agentId, kbIds, toolIds) {
  if (kbIds) { await tx.agentKnowledgeBase.deleteMany({ where: { agentId } }); if (kbIds.length) await tx.agentKnowledgeBase.createMany({ data: kbIds.map((knowledgeBaseId) => ({ agentId, knowledgeBaseId })) }); }
  if (toolIds) { await tx.agentTool.deleteMany({ where: { agentId } }); if (toolIds.length) await tx.agentTool.createMany({ data: toolIds.map((toolId) => ({ agentId, toolId })) }); }
}

export const agentsService = {
  list: (orgId, { take, cursor, status }) => prisma.agent.findMany({ where: { orgId, deletedAt: null, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: take + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { currentVersion: { select: { version: true } } } }),
  get: (orgId, id) => own(orgId, id),

  create: (orgId, userId, { name, config, knowledgeBaseIds, toolIds }) => prisma.$transaction(async (tx) => {
    await assertOwned(tx, orgId, knowledgeBaseIds, toolIds);
    const agent = await tx.agent.create({ data: { orgId, name } });
    const v = await tx.agentVersion.create({ data: { agentId: agent.id, version: 1, config, createdById: userId } });
    await setLinks(tx, agent.id, knowledgeBaseIds, toolIds);
    return tx.agent.update({ where: { id: agent.id }, data: { currentVersionId: v.id }, include: { currentVersion: true } });
  }),

  // Config edits create a new immutable version; the agent points at it (draft until published).
  update: (orgId, agentId, userId, { name, config, note, knowledgeBaseIds, toolIds }) => prisma.$transaction(async (tx) => {
    const agent = await own(orgId, agentId, tx);
    await assertOwned(tx, orgId, knowledgeBaseIds ?? [], toolIds ?? []);
    let currentVersionId = agent.currentVersionId;
    if (config) {
      const last = await tx.agentVersion.findFirst({ where: { agentId }, orderBy: { version: 'desc' } });
      currentVersionId = (await tx.agentVersion.create({ data: { agentId, version: (last?.version ?? 0) + 1, config, note, createdById: userId } })).id;
    }
    await setLinks(tx, agentId, knowledgeBaseIds, toolIds);
    return tx.agent.update({ where: { id: agentId }, data: { ...(name ? { name } : {}), currentVersionId, ...(config && agent.status === 'PUBLISHED' ? { status: 'DRAFT' } : {}) }, include: { currentVersion: true } });
  }),

  versions: async (orgId, agentId) => { await own(orgId, agentId); return prisma.agentVersion.findMany({ where: { agentId }, orderBy: { version: 'desc' }, select: { id: true, version: true, note: true, createdAt: true } }); },

  async rollback(orgId, agentId, userId, version) {
    return prisma.$transaction(async (tx) => {
      await own(orgId, agentId, tx);
      const target = await tx.agentVersion.findUnique({ where: { agentId_version: { agentId, version } } });
      if (!target) throw AppError.notFound('Version not found');
      const last = await tx.agentVersion.findFirst({ where: { agentId }, orderBy: { version: 'desc' } });
      const copy = await tx.agentVersion.create({ data: { agentId, version: last.version + 1, config: target.config, note: `Rollback to v${version}`, createdById: userId } });
      return tx.agent.update({ where: { id: agentId }, data: { currentVersionId: copy.id, status: 'DRAFT' }, include: { currentVersion: true } });
    });
  },

  // Publishing syncs the version to the voice provider. DB state changes only after the provider succeeds.
  async publish(orgId, agentId) {
    const agent = await own(orgId, agentId);
    if (!agent.currentVersion) throw AppError.conflict('Agent has no configuration');
    const provider = getVoiceProvider();
    const payload = provider.buildAssistant(await assistantPayloadFor(agent));
    const providerAssistantId = agent.providerAssistantId
      ? (await provider.updateAssistant(agent.providerAssistantId, payload), agent.providerAssistantId)
      : (await provider.createAssistant(payload)).id;
    return prisma.agent.update({ where: { id: agentId }, data: { status: 'PUBLISHED', providerAssistantId }, include: { currentVersion: true } });
  },
  async archive(orgId, agentId) { await own(orgId, agentId); return prisma.agent.update({ where: { id: agentId }, data: { status: 'ARCHIVED' } }); },
  async remove(orgId, agentId) {
    const a = await own(orgId, agentId);
    if (a.providerAssistantId) await getVoiceProvider().deleteAssistant(a.providerAssistantId).catch(() => {}); // best effort
    await prisma.agent.update({ where: { id: agentId }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });
  },
  async duplicate(orgId, agentId, userId) {
    const a = await own(orgId, agentId);
    return agentsService.create(orgId, userId, { name: `${a.name} (copy)`, config: a.currentVersion.config, knowledgeBaseIds: [], toolIds: [] });
  },
};
