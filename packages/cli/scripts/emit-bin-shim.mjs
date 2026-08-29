// Build step 2 of 2 (see tsconfig.build.json): write dist/bin/diagram.js.
//
// tsc emits the compiled binary at dist/cli/src/bin/diagram.js (rootDir is
// packages/, so core's sources compile alongside the CLI's). package.json
// points "bin" at the stable path dist/bin/diagram.js, so this writes a
// shebang shim there that imports the real entry point.
//
// Node built-ins only — the CLI takes no new dependencies.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(pkgRoot, 'dist', 'cli', 'src', 'bin', 'diagram.js');
if (!fs.existsSync(target)) {
  process.stderr.write(`emit-bin-shim: ${target} missing — did tsc run?\n`);
  process.exit(1);
}

const shimDir = path.join(pkgRoot, 'dist', 'bin');
const shim = path.join(shimDir, 'diagram.js');
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(shim, ['#!/usr/bin/env node', "import '../cli/src/bin/diagram.js';", ''].join('\n'), 'utf8');
fs.chmodSync(shim, 0o755);
