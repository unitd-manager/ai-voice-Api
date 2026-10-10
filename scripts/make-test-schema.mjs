// Derives prisma/schema.test.prisma (Rust-free "client" engine, separate output) used only by DB-backed tests.
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
writeFileSync(new URL('../prisma/schema.test.prisma', import.meta.url), src.replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  engineType = "client"\n  output = "../.tmp-prisma-client"'));
