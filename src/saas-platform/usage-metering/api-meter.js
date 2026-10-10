import { getRedis } from '../../core/database/redis.js';
import { getEntitlements } from '../entitlements/entitlements.service.js';
import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/logging/logger.js';

const cache = new Map(); // orgId -> { at, limit }
const TTL = 30_000;
const monthKey = (orgId, d = new Date()) => `api:${orgId}:${d.toISOString().slice(0, 7)}`;
export const clearMeterCache = () => cache.clear();

async function limitFor(orgId) {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL) return hit.limit;
  const ent = await getEntitlements(orgId);
  const limit = ent.active ? ent.limits.apiRequestsPerMonth ?? -1 : -1; // inactive orgs are blocked by route-level gates instead
  cache.set(orgId, { at: Date.now(), limit });
  return limit;
}

// Counts every tenant-scoped API request in Redis and enforces the plan limit. Fails OPEN if Redis/DB hiccup,
// because metering must never take the API down.
export async function apiMeter(req, _res, next) {
  try {
    if (/\/(billing|credits)$/.test(req.baseUrl)) return next(); // billing must stay reachable even over quota
    const redis = getRedis();
    const key = monthKey(req.org.id);
    const n = Number(await redis.incr(key));
    if (n === 1) await redis.expire(key, 40 * 86400);
    const limit = await limitFor(req.org.id);
    if (limit !== -1 && n > limit) return next(new AppError(429, 'API_QUOTA_EXCEEDED', 'Monthly API request limit reached'));
  } catch (err) { logger.warn({ err: err.message }, 'api meter failed open'); }
  next();
}

// Worker: copy Redis counters into the durable usage table.
export async function flushApiCounts(recordGauge) {
  const redis = getRedis(); let cursor = '0'; let flushed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'api:*', 'COUNT', 200); cursor = next;
    for (const k of keys) {
      const [, orgId, ym] = k.split(':'); const v = Number(await redis.get(k));
      if (orgId && v) { await recordGauge({ orgId, metric: 'API_REQUESTS', value: v, mode: 'set', at: new Date(`${ym}-15T00:00:00Z`) }); flushed++; }
    }
  } while (cursor !== '0');
  return flushed;
}
