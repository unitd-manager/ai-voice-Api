import { prisma } from '../../../core/database/prisma.js';
import { hmacSha256Hex } from '../../../core/security/crypto.js';
import { safeFetch } from '../../../core/security/ssrf.js';
import { decrypt } from '../../../core/security/encryption.js';
import { enqueue, QUEUES } from '../../background-jobs/queues.js';

export const sign = (secret, ts, body) => `t=${ts},v1=${hmacSha256Hex(secret, `${ts}.${body}`)}`;

// Durable first: delivery rows are written before enqueueing.
export async function emitEvent(orgId, eventType, payload) {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { orgId, enabled: true } });
  for (const ep of endpoints.filter((e) => Array.isArray(e.events) && (e.events.includes('*') || e.events.includes(eventType)))) {
    const d = await prisma.webhookDelivery.create({ data: { endpointId: ep.id, eventType, payload, nextAttemptAt: new Date() } });
    await enqueue(QUEUES.outgoingWebhooks, { deliveryId: d.id }, { jobId: `wh-${d.id}` });
  }
}
export async function deliver(deliveryId) {
  const d = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } });
  if (!d || d.status === 'SUCCEEDED') return;
  const body = JSON.stringify({ id: d.id, type: d.eventType, data: d.payload });
  const ts = Math.floor(Date.now() / 1000);
  try {
    const res = await safeFetch(d.endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sign(decrypt(d.endpoint.secret), ts, body) }, body, timeoutMs: 10000 });
    if (!res.ok) throw new Error(`status_${res.status}`);
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'SUCCEEDED', attempts: { increment: 1 }, lastError: null } });
  } catch (err) {
    await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: String(err.message).slice(0, 300) } });
    throw err;
  }
}
