import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/native',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['html', { outputFolder: 'playwright-report/tauri-native', open: 'never' }],
    ['json', { outputFile: 'playwright-report/tauri-native-results.json' }],
    ['junit', { outputFile: 'playwright-report/tauri-native-results.xml' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
