import { defineConfig } from 'vitest/config';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'mysql://lc:lc@localhost:3306/lc_test';

export default defineConfig({
  test: {
    globalSetup: ['./test/setup.ts'],
    env: { DATABASE_URL: TEST_DB, JWT_SECRET: 'test-secret-test-secret-test-secret-0000', NODE_ENV: 'test' },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
