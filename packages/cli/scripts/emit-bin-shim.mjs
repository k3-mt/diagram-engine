// Build step 2 of 2 (see tsconfig.build.json): write dist/bin/<name>.js for
// every binary in package.json's "bin" map.
//
// tsc emits the compiled entry points at dist/cli/src/bin/<name>.js (rootDir
// is packages/, so core's sources compile alongside the CLI's). package.json
// points "bin" at the stable paths dist/bin/<name>.js, so this writes a
// shebang shim at each one that imports the real entry point.
//
// Two binaries as of M6 — `diagram` (the CLI) and `diagram-mcp` (the stdio MCP
// server) — hence the loop rather than a single hard-coded target.
//
// Node built-ins only — the CLI takes no new dependencies.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shimDir = path.join(pkgRoot, 'dist', 'bin');

/** The binary names come from package.json, so the two can never disagree. */
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const names = Object.keys(pkg.bin ?? {});
if (names.length === 0) {
  process.stderr.write('emit-bin-shim: package.json declares no "bin" entries\n');
  process.exit(1);
}

fs.mkdirSync(shimDir, { recursive: true });

for (const name of names) {
  const compiled = path.join(pkgRoot, 'dist', 'cli', 'src', 'bin', `${name}.js`);
  if (!fs.existsSync(compiled)) {
    process.stderr.write(`emit-bin-shim: ${compiled} missing — did tsc run?\n`);
    process.exit(1);
  }
  // The shim's own path ends in the binary's name, which is what each entry
  // point's "was I executed directly?" check looks at — so a shim must be
  // named exactly like its target.
  const shim = path.join(shimDir, `${name}.js`);
  fs.writeFileSync(
    shim,
    ['#!/usr/bin/env node', `import '../cli/src/bin/${name}.js';`, ''].join('\n'),
    'utf8',
  );
  fs.chmodSync(shim, 0o755);
}
