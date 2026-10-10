// Usage: npm run make-admin -- someone@example.com   (grants platform-admin to an EXISTING user; run on the server)
import { PrismaClient } from '@prisma/client';
const email = process.argv[2]?.toLowerCase();
if (!email) { console.error('usage: npm run make-admin -- <email>'); process.exit(1); }
const prisma = new PrismaClient();
const r = await prisma.user.updateMany({ where: { email, deletedAt: null }, data: { isPlatformAdmin: true } });
console.log(r.count ? `${email} is now a platform admin` : 'no such user');
await prisma.$disconnect();
