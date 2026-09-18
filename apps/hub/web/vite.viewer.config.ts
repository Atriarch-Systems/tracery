import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// docs/SHARING.md "HTML export": a second, self-contained entry with
// everything (JS, CSS, even the dynamically-imported react-force-graph-2d
// chunk) inlined into one file, so it works opened straight from disk
// (file://) with no server and no /ui/ base -- unlike vite.config.ts's
// index.html, which the hub serves at /ui/ and which stays chunked/
// multi-file on purpose. `emptyOutDir: false` because this build runs
// AFTER vite.config.ts's (see package.json's `build` script) into the same
// `dist/`, and must not wipe out that first build's output.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: 'viewer.html',
    },
  },
});
