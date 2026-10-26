import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4173/toyama-moodle-downloader/',
    browserName: 'chromium',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --base=/toyama-moodle-downloader/',
    url: 'http://127.0.0.1:4173/toyama-moodle-downloader/',
    reuseExistingServer: false,
  },
});
