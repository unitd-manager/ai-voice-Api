import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { buildOpenApi } from '../../../scripts/gen-openapi.mjs';

describe('OpenAPI', () => {
  it('committed openapi.yaml matches the live routes (run `npm run openapi` if this fails)', async () => {
    expect(await buildOpenApi()).toBe(readFileSync(new URL('../../../openapi/openapi.yaml', import.meta.url), 'utf8'));
  });
  it('documents every route with auth, and request schemas come from the real validators', async () => {
    const doc = parse(await buildOpenApi());
    const ops = Object.entries(doc.paths).flatMap(([p, o]) => Object.entries(o).map(([m, op]) => ({ p, m, op })));
    expect(ops.length).toBeGreaterThan(80);
    expect(doc.paths['/orgs/{orgId}/agents'].post.requestBody.content['application/json'].schema.properties.config.properties.systemPrompt.type).toBe('string');
    expect(doc.paths['/orgs/{orgId}/agents'].get.parameters.map((x) => x.name)).toEqual(expect.arrayContaining(['orgId', 'limit', 'cursor']));
    expect(doc.paths['/auth/login'].post.security).toEqual([]);
    expect(doc.paths['/orgs/{orgId}/billing/portal'].post.description).toMatch(/billing:manage/);
    expect(doc.paths['/orgs/{orgId}/knowledge-bases/{kbId}/documents'].post.requestBody.content['multipart/form-data']).toBeTruthy();
    for (const { p, op } of ops) if (!p.startsWith('/auth') && p !== '/plans' && !p.startsWith('/webhooks')) expect(op.security.length, p).toBe(2);
  });
});
