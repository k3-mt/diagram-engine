// vite.config.ts — dev server + build for the viewer bundle.
//
// The fixtures the debug page imports live at the repo root
// (tests/fixtures/), outside this package, so the dev server's fs allow
// list is widened to the workspace root. JSON imports are inlined at
// build time, so the built bundle has no such dependency.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  worker: {
    // The layout worker is a module worker; ES output keeps the elkjs
    // CJS-to-ESM conversion consistent between dev and build.
    format: 'es',
  },
});
