import { vi } from 'vitest';
// Prisma's engine may be unavailable (e.g. offline CI); unit/integration tests never need a real DB.
vi.mock('../core/database/prisma.js', async () => ({ prisma: (await import('./fixtures/prisma-mock.js')).prismaMock }));
// In-memory Redis fake (incr/expire/get/set NX/del/scan/ping) shared by all tests.
vi.mock('../core/database/redis.js', async () => { const { fakeRedis } = await import('./fixtures/fake-redis.js'); return { getRedis: () => fakeRedis, closeRedis: async () => {} }; });
vi.mock('../platform-services/background-jobs/queues.js', () => ({ QUEUES: { postCall: 'post-call', ingestion: 'document-ingestion', outgoingWebhooks: 'outgoing-webhooks', reconcile: 'billing-reconcile', recording: 'recording-download' }, enqueue: vi.fn().mockResolvedValue({}), getQueue: vi.fn(() => ({ getJobCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }) })), closeQueues: vi.fn() }));
