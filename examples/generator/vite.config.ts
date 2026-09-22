// @ts-ignore -- build-only JavaScript plugin
import { bundleLicenses } from '../../scripts/bundle-licenses.mjs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Sends events to a hub over plain fetch() from the browser -- no dev-server
// proxy needed. Allow this page's origin with TRACERY_ALLOWED_ORIGINS on
// the hub (SPEC.md §6), and enter its URL and credentials in the app.
export default defineConfig({
  plugins: [react(), bundleLicenses()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
