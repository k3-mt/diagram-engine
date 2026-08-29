// vite.config.ts — dev server + build for the viewer bundle.
//
// The built bundle goes straight into the CLI package (spec §2.4:
// "viewer/ — browser bundle, built into cli/dist/public"), which is what
// `diagram serve` serves statically. emptyOutDir must be explicit because
// the directory sits outside this package's root.
//
// The fixtures the debug page imports live at the repo root
// (tests/fixtures/), outside this package, so the dev server's fs allow
// list is widened to the workspace root. JSON imports are inlined at
// build time, so the built bundle has no such dependency.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const cliPublicDir = fileURLToPath(new URL('../cli/dist/public', import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: cliPublicDir,
    emptyOutDir: true,
  },
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
