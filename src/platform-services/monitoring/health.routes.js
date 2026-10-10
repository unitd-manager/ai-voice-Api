import { Router } from 'express';
import { prisma } from '../../core/database/prisma.js';
import { getRedis } from '../../core/database/redis.js';

const withTimeout = (p, ms = 2000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export const healthRouter = Router();

// Liveness: the process is up.
healthRouter.get('/health', (_req, res) =>
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() }, meta: {} }));

// Readiness: dependencies are reachable.
healthRouter.get('/ready', async (_req, res) => {
  const checks = {};
  const run = async (name, fn) => {
    try { await withTimeout(fn()); checks[name] = 'ok'; } catch { checks[name] = 'unavailable'; }
  };
  await Promise.all([
    run('database', () => prisma.$queryRaw`SELECT 1`),
    run('redis', async () => { const r = getRedis(); if (r.status === 'wait') await r.connect(); return r.ping(); }),
  ]);
  const ready = Object.values(checks).every((v) => v === 'ok');
  res.status(ready ? 200 : 503).json({ success: ready, data: { status: ready ? 'ready' : 'degraded', checks }, meta: {} });
});
