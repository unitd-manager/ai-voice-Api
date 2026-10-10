import { defineConfig } from 'vitest/config';
// Infrastructure tests: REAL MySQL, Redis (BullMQ), Qdrant, S3 (s3rver), SMTP (smtp-server) + a fake OpenAI-compatible
// LLM/embedding server. Needs MySQL (schema applied), Redis :6379 and Qdrant :6333 running.  npm run test:infra
export default defineConfig({
  test: {
    include: ['src/tests/infra/**/*.infra.test.js'], setupFiles: ['src/tests/infra/setup.js'], globalSetup: ['src/tests/infra/global-setup.js'],
    testTimeout: 60000, hookTimeout: 60000, fileParallelism: false,
    env: {
      NODE_ENV: 'test', LOG_LEVEL: 'silent', APP_URL: 'https://app.example.test',
      DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://voice:voicepass@127.0.0.1:3306/voice_agent',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789', JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef0123456789',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', QDRANT_URL: process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
      EMBEDDING_BASE_URL: 'http://127.0.0.1:18089/v1', EMBEDDING_API_KEY: 'k', EMBEDDING_DIM: '64',
      LLM_BASE_URL: 'http://127.0.0.1:18089/v1', LLM_API_KEY: 'k', LLM_MODEL: 'primary', LLM_FALLBACK_MODEL: 'fallback',
      S3_ENDPOINT: 'http://127.0.0.1:14566', S3_BUCKET: 'test-bucket', S3_ACCESS_KEY_ID: 'S3RVER', S3_SECRET_ACCESS_KEY: 'S3RVER',
      SMTP_URL: 'smtp://127.0.0.1:2525', EMAIL_FROM: 'Voice <no-reply@example.test>',
      STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_URL: process.env.STRIPE_API_URL ?? 'http://127.0.0.1:12111',
    },
  },
});
