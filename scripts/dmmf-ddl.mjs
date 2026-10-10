// TEST/DEV helper: derives MySQL DDL from Prisma's own DMMF so a database can be created WITHOUT the Prisma
// schema engine (e.g. offline sandboxes). The production path is `prisma migrate dev` / `migrate deploy`.
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
const { models, enums } = Prisma.dmmf.datamodel;
// @@index declarations are not exposed by the runtime DMMF: read them from the schema text.
const schemaText = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const indexes = [...schemaText.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].flatMap(([, model, body]) => [...body.matchAll(/@@index\(\[([^\]]+)\]/g)].map((m) => ({ model, type: 'normal', fields: m[1].split(',').map((x) => ({ name: x.trim() })) })));
const enumVals = Object.fromEntries(enums.map((e) => [e.name, e.values.map((v) => v.name)]));
const q = (s) => `\`${s}\``;
function colType(f) {
  const nt = f.nativeType; // ['VarChar', ['32']]
  if (f.kind === 'enum') return `ENUM(${enumVals[f.type].map((v) => `'${v}'`).join(',')})`;
  switch (f.type) {
    case 'String': return nt ? (nt[0] === 'Text' ? 'TEXT' : `VARCHAR(${nt[1][0]})`) : 'VARCHAR(191)';
    case 'Int': return 'INT'; case 'BigInt': return 'BIGINT'; case 'Boolean': return 'BOOLEAN';
    case 'DateTime': return 'DATETIME(3)'; case 'Json': return 'JSON'; default: throw new Error(`type ${f.type}`);
  }
}
function def(f) {
  const d = f.default; if (d === undefined || d === null) return '';
  if (typeof d === 'object' && d.name === 'now') return ' DEFAULT CURRENT_TIMESTAMP(3)';
  if (typeof d === 'object') return ''; // cuid()/updatedAt handled by the client
  if (typeof d === 'boolean') return ` DEFAULT ${d ? 1 : 0}`;
  if (typeof d === 'number') return ` DEFAULT ${d}`;
  return ` DEFAULT '${d}'`;
}
const out = [];
for (const m of models) {
  const scalars = m.fields.filter((f) => f.kind !== 'object');
  const lines = scalars.map((f) => `  ${q(f.name)} ${colType(f)}${f.isRequired ? ' NOT NULL' : ' NULL'}${def(f)}`);
  const pk = m.primaryKey ? m.primaryKey.fields : scalars.filter((f) => f.isId).map((f) => f.name);
  lines.push(`  PRIMARY KEY (${pk.map(q).join(',')})`);
  const uniq = [...scalars.filter((f) => f.isUnique).map((f) => [f.name]), ...m.uniqueFields];
  uniq.forEach((u, i) => lines.push(`  UNIQUE KEY ${q(`${m.name}_u${i}`)} (${u.map(q).join(',')})`));
  indexes.filter((ix) => ix.model === m.name && ix.type === 'normal').forEach((ix, i) => lines.push(`  KEY ${q(`${m.name}_i${i}`)} (${ix.fields.map((f) => q(f.name)).join(',')})`));
  out.push(`CREATE TABLE ${q(m.name)} (\n${lines.join(',\n')}\n) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
}
for (const m of models) for (const f of m.fields.filter((x) => x.kind === 'object' && x.relationFromFields?.length)) {
  const act = { Cascade: 'CASCADE', SetNull: 'SET NULL', Restrict: 'RESTRICT', NoAction: 'NO ACTION' }[f.relationOnDelete] ?? (f.isRequired ? 'RESTRICT' : 'SET NULL');
  out.push(`ALTER TABLE ${q(m.name)} ADD CONSTRAINT ${q(`${m.name}_${f.name}_fk`)} FOREIGN KEY (${f.relationFromFields.map(q).join(',')}) REFERENCES ${q(f.type)} (${f.relationToFields.map(q).join(',')}) ON DELETE ${act} ON UPDATE CASCADE;`);
}
console.log(out.join('\n'));
