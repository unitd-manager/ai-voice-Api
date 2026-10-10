import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

export const prisma = globalThis.__prisma ?? new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
if (env.NODE_ENV !== 'production') globalThis.__prisma = prisma;
