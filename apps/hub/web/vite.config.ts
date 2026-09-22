// @ts-ignore -- build-only JavaScript plugin
import { bundleLicenses } from '../../../scripts/bundle-licenses.mjs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPEC.md §6 "Hosted UI": built to apps/hub/web/dist and served by the hub as
// static files at /ui, so every asset URL must be rooted at /ui/.
export default defineConfig({
  base: '/ui/',
  plugins: [react(), bundleLicenses()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
