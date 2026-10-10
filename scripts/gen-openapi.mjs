// Generates openapi/openapi.yaml from the REAL router stack and the Zod validators attached to each route,
// so the docs cannot drift from the implementation (a unit test fails if the committed file is stale).
import { z } from 'zod';
import { stringify } from 'yaml';
import { writeFileSync } from 'node:fs';

export async function buildOpenApi() {
  const { MOUNTS } = await import('../src/routes/index.js');
  const paths = {};
  const PUBLIC = [/^\/auth\//, /^\/plans$/, /^\/webhooks\//];
  const schemaOf = (s) => { try { const j = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }); delete j.$schema; return j; } catch { return { type: 'object' }; } };
  for (const [prefix, router] of MOUNTS) {
    for (const layer of router.stack.filter((l) => l.route)) {
      const route = layer.route;
      const full = (prefix + (route.path === '/' ? '' : route.path)) || '/';
      const path = full.replace(/:(\w+)/g, '{$1}');
      const handlers = route.stack.map((l) => l.handle);
      const perm = handlers.find((h) => h.permission)?.permission;
      const val = handlers.find((h) => h.schemas)?.schemas ?? {};
      const isPublic = PUBLIC.some((r) => r.test(path.replace(/\{.*?\}/g, '')) ) || PUBLIC.some((r) => r.test(path));
      const upload = handlers.some((h) => h.name === 'multerMiddleware');
      const tag = path.split('/').filter((x) => x && !x.startsWith('{'))[path.startsWith('/orgs/{') ? 1 : 0] ?? 'misc';
      for (const method of Object.keys(route.methods)) {
        const op = { tags: [tag], summary: `${method.toUpperCase()} ${path}`, operationId: `${method}_${path.replace(/[{}]/g, '').replace(/\W+/g, '_')}`.replace(/_+$/, '') };
        if (perm) op.description = `Requires permission \`${perm}\` in the organization.`;
        op.security = isPublic ? [] : [{ bearerAuth: [] }, { apiKey: [] }];
        const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
        if (val.query) { const q = schemaOf(val.query); for (const [name, sch] of Object.entries(q.properties ?? {})) params.push({ name, in: 'query', required: (q.required ?? []).includes(name), schema: sch }); }
        if (params.length) op.parameters = params;
        if (upload) op.requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } } } };
        else if (val.body) op.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(val.body) } } };
        op.responses = { [method === 'post' && !/(login|refresh|logout|verify|forgot|reset|publish|archive|rollback|terminate|execute|test|retry|reconcile|suspend|credits|read|search|chat|portal|checkout|accept|evaluate|delete|reprocess)/.test(path) ? '201' : '200']: { description: 'Success: { success: true, data, meta }' }, '400': { $ref: '#/components/responses/Error' } };
        if (!isPublic) op.responses['401'] = { $ref: '#/components/responses/Error' };
        if (perm) { op.responses['403'] = { $ref: '#/components/responses/Error' }; op.responses['404'] = { $ref: '#/components/responses/Error' }; }
        (paths[path] ??= {})[method] = op;
      }
    }
  }
  const sorted = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
  return stringify({
    openapi: '3.0.3',
    info: { title: 'Voice Agent SaaS API', version: '0.2.0', description: 'Generated from the live route table and Zod validators. Success: `{success:true,data,meta}`. Error: `{success:false,error:{code,message},requestId}`. Tenant routes live under /orgs/{orgId}; access is decided server-side from membership (users) or the bound organization (API keys). POST endpoints that move money or start calls accept an `Idempotency-Key` header.' },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
      schemas: { Error: { type: 'object', properties: { success: { type: 'boolean', example: false }, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } }, requestId: { type: 'string' } } } },
      responses: { Error: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    paths: sorted,
  }, { lineWidth: 0 });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  process.env.DATABASE_URL ??= 'mysql://u:p@localhost:3306/db'; process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(40); process.env.JWT_REFRESH_SECRET ??= 'y'.repeat(40);
  const yaml = await buildOpenApi(); writeFileSync(new URL('../openapi/openapi.yaml', import.meta.url), yaml);
  console.log(`openapi.yaml written (${(yaml.match(/operationId/g) ?? []).length} operations)`); process.exit(0);
}
