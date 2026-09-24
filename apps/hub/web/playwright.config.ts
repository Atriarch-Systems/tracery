import { defineConfig } from '@playwright/test';

// No global webServer here: the two spec files need very different servers
// (a plain `vite preview` of the built app with a mocked hub for
// explorer.mocked.spec.ts, vs. an actual `@atriarch-systems/tracery-hub` process
// serving this app's dist/ at /ui for explorer.real-hub.spec.ts) and start
// their own in `test.beforeAll`/`afterAll`.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
  },
});
