import { vi } from 'vitest';
vi.mock('../../core/database/prisma.js', async () => ({ prisma: (await import('./db-client.js')).realPrisma }));
vi.mock('../../core/database/redis.js', async () => { const { fakeRedis } = await import('../fixtures/fake-redis.js'); return { getRedis: () => fakeRedis, closeRedis: async () => {} }; });
vi.mock('../../platform-services/background-jobs/queues.js', () => ({ QUEUES: { postCall: 'post-call', ingestion: 'document-ingestion', outgoingWebhooks: 'outgoing-webhooks', reconcile: 'billing-reconcile', recording: 'recording-download' }, enqueue: vi.fn().mockResolvedValue({}), getQueue: vi.fn(() => ({ getJobCounts: async () => ({}) })), closeQueues: vi.fn() }));
