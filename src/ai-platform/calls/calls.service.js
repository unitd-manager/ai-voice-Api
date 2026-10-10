import { prisma } from '../../core/database/prisma.js';
import { AppError } from '../../core/errors/app-error.js';
import { getVoiceProvider } from '../voice-engine/provider.factory.js';
import { assertCanStartCall } from '../../saas-platform/entitlements/entitlements.service.js';
import { recordUsage, recordGauge } from '../../saas-platform/usage-metering/usage.service.js';
import { reserve, settleReservation } from '../../saas-platform/usage-metering/reservations.service.js';
import { checkUsageAlerts } from '../../saas-platform/usage-metering/alerts.service.js';
import { resolveCall } from '../telephony/inbound.service.js';
import { enqueue, QUEUES } from '../../platform-services/background-jobs/queues.js';

const TERMINAL = ['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY', 'CANCELED'];

export const callsService = {
  async startOutbound(orgId, { agentId, toNumber, phoneNumberId }) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, orgId, deletedAt: null, status: 'PUBLISHED' }, include: { currentVersion: true } });
    if (!agent?.providerAssistantId) throw AppError.notFound('Published agent not found');
    const phone = await prisma.phoneNumber.findFirst({ where: { id: phoneNumberId, orgId } });
    if (!phone?.providerNumberId) throw AppError.notFound('Phone number not found');
    const ent = await assertCanStartCall(orgId); // server-side quota + concurrency gate
    const call = await prisma.call.create({ data: { orgId, agentId, agentVersionId: agent.currentVersionId, direction: 'OUTBOUND', status: 'QUEUED', fromNumber: phone.e164, toNumber } });
    try {
      // Hard-capped plans: hold the worst-case minutes up front so parallel starts cannot jointly overshoot.
      if (ent.limits.hardCap && ent.limits.callMinutes !== -1) {
        const maxMin = Math.ceil((agent.currentVersion?.config?.maxCallDurationSeconds ?? 900) / 60);
        await reserve({ orgId, quantity: maxMin, limit: ent.limits.callMinutes, callId: call.id });
      }
      recordGauge({ orgId, metric: 'CONCURRENT_CALLS', value: (await prisma.call.count({ where: { orgId, status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } } })), mode: 'max' }).catch(() => {});
      const res = await getVoiceProvider().startOutboundCall({ assistantId: agent.providerAssistantId, phoneNumberId: phone.providerNumberId, toNumber, metadata: { callId: call.id, orgId } });
      return await prisma.call.update({ where: { id: call.id }, data: { providerCallId: res.id } });
    } catch (e) {
      await settleReservation(call.id, 'RELEASED').catch(() => {});
      await prisma.call.update({ where: { id: call.id }, data: { status: 'FAILED', endReason: e.code === 'USAGE_CAP_REACHED' ? 'usage_cap' : 'provider_error' } });
      await prisma.callEvent.create({ data: { callId: call.id, type: 'start_failed', payload: { code: e.code } } });
      throw e;
    }
  },
  list: (orgId, { take, cursor, status, agentId }) => prisma.call.findMany({ where: { orgId, ...(status ? { status } : {}), ...(agentId ? { agentId } : {}) }, orderBy: { createdAt: 'desc' }, take: take + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
  async get(orgId, callId) {
    const c = await prisma.call.findFirst({ where: { id: callId, orgId }, include: { transcript: { orderBy: { seq: 'asc' } }, events: { orderBy: { createdAt: 'asc' } } } });
    if (!c) throw AppError.notFound('Call not found');
    return c;
  },
  async terminate(orgId, callId) {
    const c = await prisma.call.findFirst({ where: { id: callId, orgId } });
    if (!c) throw AppError.notFound('Call not found');
    if (TERMINAL.includes(c.status)) throw AppError.conflict('Call already ended');
    if (c.providerCallId) await getVoiceProvider().endCall(c.providerCallId);
    return prisma.call.findUnique({ where: { id: callId } });
  },

  // Applies a normalized provider event. Safe to run more than once (all writes are idempotent).
  async applyProviderEvent(evt) {
    if (!evt.providerCallId) return;
    const call = await resolveCall(evt); // finds the call, or creates it for inbound calls to our numbers
    if (!call) return; // unknown call: stays in the webhook inbox for reconciliation
    const d = evt.data ?? {};
    await prisma.callEvent.create({ data: { callId: call.id, type: evt.type, payload: { status: evt.status, endedReason: d.endedReason } } });
    if (TERMINAL.includes(call.status)) return; // never regress a finished call
    if (evt.status === 'IN_PROGRESS' && call.status !== 'IN_PROGRESS') await prisma.call.update({ where: { id: call.id }, data: { status: 'IN_PROGRESS', startedAt: d.startedAt ? new Date(d.startedAt) : new Date() } });
    else if (evt.status && evt.status !== 'COMPLETED') await prisma.call.update({ where: { id: call.id }, data: { status: evt.status } });
    if (evt.type === 'end-of-call-report' || evt.status === 'COMPLETED') await callsService.finalize(call, d);
  },

  async finalize(call, d) {
    const seconds = Math.max(0, Math.round(Number(d.durationSeconds ?? 0)));
    const costMinor = d.cost != null ? Math.round(Number(d.cost) * 100) : null;
    await prisma.$transaction(async (tx) => {
      await tx.call.update({ where: { id: call.id }, data: { status: 'COMPLETED', durationSeconds: seconds, endedAt: d.endedAt ? new Date(d.endedAt) : new Date(), endReason: d.endedReason, providerCostMinor: costMinor, summary: d.summary ?? undefined } });
      if (Array.isArray(d.transcript) && d.transcript.length) {
        await tx.transcriptSegment.deleteMany({ where: { callId: call.id } });
        await tx.transcriptSegment.createMany({ data: d.transcript.filter((m) => m.role !== 'system').map((m, i) => ({ callId: call.id, seq: i, speaker: m.role === 'user' ? 'customer' : 'agent', text: String(m.message ?? m.content ?? '').slice(0, 10000) })) });
      }
    });
    // Usage is recorded with deterministic idempotency keys: retried webhooks cannot double-bill.
    await recordUsage({ orgId: call.orgId, metric: 'CALL_MINUTES', quantity: Math.ceil(seconds / 60), idempotencyKey: `call:${call.id}:minutes`, callId: call.id });
    if (costMinor) await recordUsage({ orgId: call.orgId, metric: 'PROVIDER_COST', quantity: costMinor, costMinor, idempotencyKey: `call:${call.id}:cost`, callId: call.id });
    await settleReservation(call.id, 'COMMITTED').catch(() => {});
    await checkUsageAlerts(call.orgId).catch(() => {}); // alerting must never fail billing
    if (d.recordingUrl) await enqueue(QUEUES.recording, { callId: call.id, url: d.recordingUrl }, { jobId: `rec-${call.id}` });
    await enqueue(QUEUES.postCall, { callId: call.id }, { jobId: `postcall-${call.id}` });
  },
};
