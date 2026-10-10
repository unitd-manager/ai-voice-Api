import { defineConfig } from 'vitest/config';
// DB-backed tests: real MySQL/MariaDB, no Prisma mocks. Run: RUN_DB_TESTS=1 DATABASE_URL=... npm run test:db
export default defineConfig({
  test: {
    include: ['src/tests/db/**/*.db.test.js'], setupFiles: ['src/tests/db/setup.js'], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789', JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef0123456789', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' },
  },
});
