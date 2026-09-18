import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: 'data/playwright-results',
  use: {
    baseURL: 'http://127.0.0.1:8891',
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'sidebar-300', use: { viewport: { width: 300, height: 1000 } } },
    { name: 'panel-460', use: { viewport: { width: 460, height: 1050 } } },
  ],
  webServer: {
    command: 'node tools/preview.mjs',
    url: 'http://127.0.0.1:8891',
    reuseExistingServer: true,
    timeout: 15_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});