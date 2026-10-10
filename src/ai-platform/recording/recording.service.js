import { prisma } from '../../core/database/prisma.js';
import { safeFetchBuffer } from '../../core/security/ssrf.js';
import { storage } from '../../platform-services/storage/storage.service.js';

// Copies the provider-hosted recording into OUR storage (so retention/deletion is under our control).
export async function fetchAndStoreRecording(callId, url) {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true, orgId: true } });
  if (!call) return null;
  const { buffer, contentType } = await safeFetchBuffer(url);
  if (!/^audio\//.test(contentType) && !/octet-stream/.test(contentType)) throw new Error('Unexpected recording content type');
  const storageKey = `orgs/${call.orgId}/recordings/${call.id}`;
  await storage.put(storageKey, buffer, contentType.split(';')[0]);
  const data = { orgId: call.orgId, storageKey, contentType: contentType.split(';')[0], sizeBytes: BigInt(buffer.length), deletedAt: null };
  await prisma.recording.upsert({ where: { callId: call.id }, create: { callId: call.id, ...data }, update: data });
  return { bytes: buffer.length };
}
