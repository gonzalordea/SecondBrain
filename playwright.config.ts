import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: {
    // The real server with a fresh in-memory database, real embeddings and no API key (assistant disabled).
    command: 'npm run build && node server/index.ts',
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { PORT: String(PORT), HOST: '127.0.0.1', PGLITE_DIR: 'memory://', LOG_LEVEL: 'warn', ANTHROPIC_API_KEY: '', VERSION_COALESCE_SECONDS: '0' },
  },
});
