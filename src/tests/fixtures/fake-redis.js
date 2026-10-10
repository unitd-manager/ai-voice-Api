const store = new Map();
export const fakeRedis = {
  status: 'ready',
  async ping() { return 'PONG'; },
  async incr(k) { const v = Number(store.get(k) ?? 0) + 1; store.set(k, String(v)); return v; },
  async expire() { return 1; },
  async get(k) { return store.get(k) ?? null; },
  async set(k, v, ...args) { if (args.includes('NX') && store.has(k)) return null; store.set(k, v); return 'OK'; },
  async del(k) { return store.delete(k) ? 1 : 0; },
  async scan() { return ['0', [...store.keys()].filter((k) => k.startsWith('api:'))]; },
  _reset() { store.clear(); },
};
