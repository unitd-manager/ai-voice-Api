import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prismaMock, resetPrismaMock } from '../fixtures/prisma-mock.js';
import { signAccessToken } from '../../core/security/tokens.js';
import { sha256 } from '../../core/security/crypto.js';

const app = createApp();
const bearer = (uid) => ({ Authorization: `Bearer ${signAccessToken(uid)}` });
beforeEach(() => resetPrismaMock());

describe('authentication', () => {
  it('rejects missing token with 401', async () => { const r = await request(app).get('/api/v1/orgs/o1/agents'); expect(r.status).toBe(401); expect(r.body.error.code).toBe('UNAUTHORIZED'); });
  it('rejects garbage token', async () => { expect((await request(app).get('/api/v1/orgs/o1/agents').set('Authorization', 'Bearer nope')).status).toBe(401); });
  it('rejects a token signed with the wrong secret', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const t = jwt.sign({ sub: 'u1' }, 'x'.repeat(40));
    expect((await request(app).get('/api/v1/orgs/o1/agents').set('Authorization', `Bearer ${t}`)).status).toBe(401);
  });
  it('rejects alg=none tokens', async () => {
    const t = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"u1"}').toString('base64url')}.`;
    expect((await request(app).get('/api/v1/orgs/o1/agents').set('Authorization', `Bearer ${t}`)).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('non-member gets 404 (not 403) for another org: no existence oracle', async () => {
    prismaMock.membership.findUnique.mockResolvedValue(null);
    const r = await request(app).get('/api/v1/orgs/ORG_B/agents').set(bearer('userA'));
    expect(r.status).toBe(404);
    expect(prismaMock.agent.findMany).not.toHaveBeenCalled(); // handler never reached
  });
  it('membership lookup is keyed on the authenticated user, not client input', async () => {
    prismaMock.membership.findUnique.mockResolvedValue(null);
    await request(app).get('/api/v1/orgs/ORG_B/agents').set(bearer('userA')).set('x-org-id', 'ORG_A').set('x-user-id', 'admin');
    expect(prismaMock.membership.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_orgId: { userId: 'userA', orgId: 'ORG_B' } } }));
  });
  it('soft-deleted org is inaccessible', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: 'OWNER', org: { deletedAt: new Date() } });
    expect((await request(app).get('/api/v1/orgs/O/agents').set(bearer('u'))).status).toBe(404);
  });
  it('API key bound to org A cannot access org B', async () => {
    prismaMock.apiKey.findUnique.mockResolvedValue({ id: 'k1', orgId: 'ORG_A', role: 'ADMIN', revokedAt: null });
    prismaMock.apiKey.update.mockResolvedValue({});
    const r = await request(app).get('/api/v1/orgs/ORG_B/agents').set('x-api-key', 'va_secret');
    expect(r.status).toBe(404);
    expect(prismaMock.apiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: sha256('va_secret') } }); // only the hash is looked up
  });
  it('revoked API key is rejected', async () => {
    prismaMock.apiKey.findUnique.mockResolvedValue({ id: 'k1', orgId: 'A', role: 'ADMIN', revokedAt: new Date() });
    expect((await request(app).get('/api/v1/orgs/A/agents').set('x-api-key', 'va_x')).status).toBe(401);
  });
  it('agent query always includes orgId (cross-tenant id reads as 404)', async () => {
    prismaMock.membership.findUnique.mockResolvedValue({ role: 'VIEWER', org: { deletedAt: null } });
    prismaMock.agent.findFirst.mockResolvedValue(null);
    const r = await request(app).get('/api/v1/orgs/ORG_A/agents/AGENT_OF_B').set(bearer('u'));
    expect(r.status).toBe(404);
    expect(prismaMock.agent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'AGENT_OF_B', orgId: 'ORG_A' }) }));
  });
});

describe('RBAC on routes', () => {
  const agentBody = { name: 'A', config: { systemPrompt: 'hi', model: {} } };
  const asRole = (role) => prismaMock.membership.findUnique.mockResolvedValue({ role, org: { deletedAt: null } });
  it('viewer cannot create agents (403)', async () => { asRole('VIEWER'); expect((await request(app).post('/api/v1/orgs/O/agents').set(bearer('u')).send(agentBody)).status).toBe(403); });
  it('analyst cannot create API keys', async () => { asRole('ANALYST'); expect((await request(app).post('/api/v1/orgs/O/api-keys').set(bearer('u')).send({ name: 'k' })).status).toBe(403); });
  it('developer cannot manage billing', async () => { asRole('DEVELOPER'); expect((await request(app).post('/api/v1/orgs/O/billing/portal').set(bearer('u'))).status).toBe(403); });
  it('developer cannot invite members', async () => { asRole('DEVELOPER'); expect((await request(app).post('/api/v1/orgs/O/invitations').set(bearer('u')).send({ email: 'a@b.co' })).status).toBe(403); });
  it('validation runs before DB work (400 on bad body)', async () => { asRole('OWNER'); const r = await request(app).post('/api/v1/orgs/O/agents').set(bearer('u')).send({ name: '' }); expect(r.status).toBe(400); expect(r.body.error.code).toBe('VALIDATION_ERROR'); });
  it('admin cannot grant owner role via API key creation', async () => {
    asRole('ADMIN'); // body role enum excludes OWNER entirely
    expect((await request(app).post('/api/v1/orgs/O/api-keys').set(bearer('u')).send({ name: 'k', role: 'OWNER' })).status).toBe(400);
  });
});
