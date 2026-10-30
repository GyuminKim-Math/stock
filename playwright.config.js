import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:3107', browserName: 'chromium' },
  webServer: {
    command: 'node server.js',
    env: { PORT: '3107' },
    url: 'http://127.0.0.1:3107',
    reuseExistingServer: false,
  },
});
