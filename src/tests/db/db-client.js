// Real Prisma client for DB-backed tests: Rust-free "client" engine + MariaDB/MySQL driver adapter,
// so no engine binary download is needed. Requires DATABASE_URL pointing at a schema-initialised database.
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../../.tmp-prisma-client/index.js';
const u = new URL(process.env.DATABASE_URL);
export const realPrisma = new PrismaClient({ adapter: new PrismaMariaDb({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1), connectionLimit: 10 }) });
