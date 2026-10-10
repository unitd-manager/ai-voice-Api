import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../core/config/env.js';

describe('env validation', () => {
  const valid = {
    DATABASE_URL: 'mysql://u:p@h:3306/db',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
  };
  it('accepts a valid config and applies defaults', () => {
    const e = loadEnv(valid);
    expect(e.PORT).toBe(3000);
    expect(e.REDIS_URL).toContain('redis://');
  });
  it('rejects short secrets', () => {
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });
  it('rejects non-mysql DATABASE_URL and missing values', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'postgres://x' })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({})).toThrow(/Invalid environment/);
  });
});
