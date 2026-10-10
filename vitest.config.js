import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
    exclude: ['src/tests/live/**', 'src/tests/db/**', 'node_modules/**'],
    setupFiles: ['src/tests/setup.js'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'mysql://u:p@localhost:3306/test',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789',
      LLM_BASE_URL: 'https://llm.test/v1',
      LLM_API_KEY: 'llm-key',
      LLM_FALLBACK_MODEL: 'fallback-model',
      VAPI_WEBHOOK_SECRET: 'vapi-test-secret',
      VAPI_API_KEY: 'vapi-test-key',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef0123456789',
    },
  },
});
