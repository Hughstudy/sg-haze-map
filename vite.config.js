import { defineConfig } from 'vite';

// Relative base so the build works at https://<user>.github.io/<any-repo-name>/
export default defineConfig({
  base: './',
  // three.js alone is ~550 kB minified (~150 kB gzipped); one chunk is fine here.
  build: { chunkSizeWarningLimit: 800 },
});
