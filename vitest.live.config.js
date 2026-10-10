import { defineConfig } from 'vitest/config';
// Real-provider smoke tests. Never run in CI by default. Needs real credentials in the environment:
//   LIVE_TESTS=1 LLM_BASE_URL=… LLM_API_KEY=… EMBEDDING_BASE_URL=… EMBEDDING_API_KEY=… QDRANT_URL=… VAPI_API_KEY=… npm run test:live
export default defineConfig({ test: { include: ['src/tests/live/**/*.live.test.js'], testTimeout: 60000, env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://u:p@localhost/db', JWT_ACCESS_SECRET: 'x'.repeat(40), JWT_REFRESH_SECRET: 'y'.repeat(40) } } });
