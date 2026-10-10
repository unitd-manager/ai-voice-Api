import { vi } from 'vitest';
// Only Prisma is swapped (for the Rust-free client); Redis, BullMQ, Qdrant, S3 and SMTP are REAL here.
vi.mock('../../core/database/prisma.js', async () => ({ prisma: (await import('../db/db-client.js')).realPrisma }));
