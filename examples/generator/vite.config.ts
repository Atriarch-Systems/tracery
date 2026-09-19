import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Sends events to a hub over plain fetch() from the browser -- no dev-server
// proxy needed, since the hub sets no CORS restriction on POST /v1/events
// (SPEC.md §6) and the user types in whatever hub URL they're running.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
