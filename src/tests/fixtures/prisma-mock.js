import { vi } from 'vitest';
// Auto-mocking Prisma: prisma.<model>.<method> is a memoized vi.fn(). $transaction runs callbacks with the same mock.
const models = new Map();
export const rawExec = vi.fn().mockResolvedValue(1);
const model = (name) => {
  if (!models.has(name)) { const fns = new Map(); models.set(name, new Proxy({}, { get: (_t, m) => { if (!fns.has(m)) fns.set(m, vi.fn()); return fns.get(m); } })); }
  return models.get(name);
};
export const prismaMock = new Proxy({}, {
  get(_t, k) {
    if (k === '$transaction') return async (arg) => (typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg));
    if (k === '$queryRaw') return vi.fn().mockResolvedValue([1]);
    if (k === '$executeRaw') return rawExec;
    if (k === '$disconnect') return vi.fn();
    if (k === 'then') return undefined;
    return model(String(k));
  },
});
export const resetPrismaMock = () => { for (const m of models.values()) for (const k of Object.keys(m)) m[k].mockReset(); };
