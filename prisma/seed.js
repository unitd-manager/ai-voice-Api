import { PrismaClient } from '@prisma/client';
import { seedPlans } from '../src/saas-platform/plans/seed-plans.js';

const prisma = new PrismaClient();
console.log('Seeded plans:', (await seedPlans(prisma)).join(', '));
await prisma.$disconnect();
