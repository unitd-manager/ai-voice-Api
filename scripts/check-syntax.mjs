import { execFileSync } from 'node:child_process'; import { readdirSync, statSync } from 'node:fs'; import { join } from 'node:path';
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : /\.m?js$/.test(f) ? [p] : []; });
let bad = 0; for (const f of [...walk('src'), ...walk('prisma'), ...walk('scripts')]) { try { execFileSync('node', ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(f, String(e.stderr).split('\n')[0]); } }
console.log(bad ? `${bad} file(s) with syntax errors` : 'all files parse'); process.exit(bad ? 1 : 0);
