// Static check: every prisma.<model>.<method>() / tx.<model>.<method>() and compound-unique key used in src/ exists in the schema.
import { Prisma } from '@prisma/client';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const models = Object.fromEntries(Prisma.dmmf.datamodel.models.map((m) => [m.name[0].toLowerCase() + m.name.slice(1), m]));
const METHODS = new Set(['findUnique', 'findFirst', 'findMany', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy']);
const uniques = new Set(); for (const m of Object.values(models)) for (const u of [...m.uniqueFields, ...(m.primaryKey ? [m.primaryKey.fields] : [])]) uniques.add(u.join('_'));
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'tests' ? [] : walk(p)) : p.endsWith('.js') ? [p] : []; });
let bad = 0, n = 0;
for (const file of [...walk('src'), 'prisma/seed.js']) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\b(?:prisma|tx)\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)) {
    n++; const [, model, method] = m;
    if (!models[model]) { console.log(`UNKNOWN MODEL  ${file}: ${model}.${method}`); bad++; } else if (!METHODS.has(method)) { console.log(`UNKNOWN METHOD ${file}: ${model}.${method}`); bad++; }
  }
  for (const m of src.matchAll(/\b([a-zA-Z]+_[a-zA-Z_]+): \{/g)) { const k = m[1]; if (/^(orgId|userId|agentId|planId|callId|source|providerPriceId)_/.test(k) && !uniques.has(k)) { console.log(`UNKNOWN COMPOUND KEY ${file}: ${k}`); bad++; } }
}
console.log(`checked ${n} prisma calls; problems: ${bad}`);
process.exit(bad ? 1 : 0);
