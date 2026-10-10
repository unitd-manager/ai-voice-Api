import { createHash } from 'node:crypto';
import { getRedis } from '../database/redis.js';
import { fail } from '../response/respond.js';
import { logger } from '../logging/logger.js';

const TTL = 24 * 3600;
// POST + `Idempotency-Key` header ⇒ the first request runs, retries replay the stored response.
// Same key with a different body is rejected. Fails open if Redis is unavailable.
export async function idempotent(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (req.method !== 'POST' || typeof key !== 'string') return next();
  if (!/^[\w-]{8,128}$/.test(key)) return fail(res, 400, 'BAD_REQUEST', 'Invalid Idempotency-Key');
  const scope = `idem:${req.org?.id ?? 'global'}:${req.baseUrl}${req.path}:${key}`;
  const bodyHash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
  let redis;
  try {
    redis = getRedis();
    const created = await redis.set(scope, JSON.stringify({ state: 'processing', bodyHash }), 'EX', TTL, 'NX');
    if (!created) {
      const rec = JSON.parse(await redis.get(scope));
      if (rec.bodyHash !== bodyHash) return fail(res, 422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request body');
      if (rec.state === 'processing') return fail(res, 409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still processing');
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(rec.status).json(rec.body);
    }
  } catch (err) { logger.warn({ err: err.message }, 'idempotency failed open'); return next(); }
  const json = res.json.bind(res);
  res.json = (body) => {
    const store = res.statusCode >= 500 ? redis.del(scope) : redis.set(scope, JSON.stringify({ state: 'done', bodyHash, status: res.statusCode, body }), 'EX', TTL);
    Promise.resolve(store).catch(() => {});
    return json(body);
  };
  next();
}
