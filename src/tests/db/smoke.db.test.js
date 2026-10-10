import { describe, it, expect } from 'vitest';
const { prisma } = await import('../../core/database/prisma.js');
describe('db smoke', () => { it('connects and round-trips a row', async () => { const u = await prisma.user.create({ data: { email: `smoke-${Date.now()}@x.co`, passwordHash: 'x' } }); expect((await prisma.user.findUnique({ where: { id: u.id } })).email).toBe(u.email); }); });
