import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Ground rule R3 / spec §16.3.
// Widening this list is a HUMAN decision. Open a gate in LEDGER.md.
const ALLOWED_RUNTIME = new Set([
  'zod',
  '@modelcontextprotocol/sdk',
  'elkjs',
  'commander',
  'chokidar',
  'ws',
  'react',
  'react-dom',
]);

// Internal workspace packages, ignored: they resolve inside this repo and
// carry no supply-chain risk of their own.
const WORKSPACE_SCOPES = ['@diagram-engine/', '@topology/'];

// `fixtures/` holds the reference systems the eval harness reads (BUILD.md
// P3-01/P3-03). Their package.json files are FIXTURE CONTENT, not manifests of
// this repo: nothing there is ever installed, built or started (ground rule
// R2), so their dependencies carry no supply-chain risk here and must not be
// held to the R3 allowlist. Deliberately not a wildcard — only this one dir.
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'logs', 'fixtures']);
const fails = [];

function walk(dir, fn) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, fn); else fn(p);
  }
}

walk('.', (p) => {
  if (!p.endsWith('package.json')) return;
  let pkg; try { pkg = JSON.parse(readFileSync(p, 'utf8')); } catch { return; }
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    // A workspace depending on a sibling in the same monorepo is not a
    // third-party dependency and must not need an allowlist entry.
    if (WORKSPACE_SCOPES.some((s) => dep.startsWith(s))) continue;
    if (!ALLOWED_RUNTIME.has(dep)) {
      fails.push(`${p}: runtime dependency "${dep}" is not on the allowlist`);
    }
  }
});

if (fails.length) {
  console.error('check:deps FAILED (ground rule R3)\n' +
    fails.map(f => '  ' + f).join('\n') +
    '\n\nDo not edit the allowlist to make this pass. Open a gate in LEDGER.md.');
  process.exit(1);
}
console.log('check:deps ok');
