import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import express from 'express';

// Prisma/Redis are mocked: the Prisma engine is not available in every environment and these tests
// target HTTP behaviour, not the database.
vi.mock('../../core/database/prisma.js', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([1]) } }));
vi.mock('../../core/database/redis.js', () => ({
  getRedis: () => ({ status: 'ready', ping: vi.fn().mockResolvedValue('PONG') }),
  closeRedis: vi.fn(),
}));

const { createApp } = await import('../../app.js');
const { validate } = await import('../../core/middleware/validate.js');
const { errorHandler } = await import('../../core/middleware/error-handler.js');
const { AppError } = await import('../../core/errors/app-error.js');

describe('app foundation', () => {
  const app = createApp();

  it('GET /health returns ok with a request id header', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /ready reports dependency status', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.checks).toEqual({ database: 'ok', redis: 'ok' });
  });

  it('unknown route returns the standard error envelope', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(res.body.requestId).toBeTruthy();
  });

  it('malformed JSON yields 400 without leaking internals', async () => {
    const res = await request(app).post('/api/v1/x').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/SyntaxError|node_modules/);
  });

  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('validation + error handling', () => {
  const a = express();
  a.use(express.json());
  a.post('/t', validate({ body: z.object({ email: z.string().email() }) }), (req, res) => res.json({ ok: true }));
  a.get('/boom', () => { throw new Error('secret db password leaked'); });
  a.get('/forbidden', () => { throw AppError.forbidden(); });
  a.use(errorHandler);

  it('returns VALIDATION_ERROR with field details', async () => {
    const res = await request(a).post('/t').send({ email: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('email');
  });
  it('hides unexpected error messages', async () => {
    const res = await request(a).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.message).not.toMatch(/secret/);
  });
  it('maps AppError to its status', async () => {
    expect((await request(a).get('/forbidden')).status).toBe(403);
  });
});
