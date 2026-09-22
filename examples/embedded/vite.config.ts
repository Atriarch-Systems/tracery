// @ts-ignore -- build-only JavaScript plugin
import { bundleLicenses } from '../../scripts/bundle-licenses.mjs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Library-mode example: no hub, no server of any kind. This is a plain
// static SPA build -- `vite preview` serves the built dist/ directly.
export default defineConfig({
  plugins: [react(), bundleLicenses()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
