// scripts/verify-plugin.mjs — the reproducible-build check (spec §16.8).
//
// WHY THIS IS NOT OPTIONAL. A committed dist/ produces diffs nobody can read,
// which trades one supply-chain problem for another: "we ship a prebuilt
// bundle" becomes "we ship a binary nobody can verify". The argument that the
// plugin is safe rests entirely on a reviewer being able to rebuild the tag
// and confirm the committed artifact matches the source. Without step 3 of
// §16.8 the artifact is unauditable.
//
// What it does: hashes every file in plugin/ and compares against
// plugin.sha256. Run `--write` after an intentional build to record the new
// manifest; run it bare in CI, and on a release tag, to prove nothing in the
// shipped bundle came from anywhere but the source in this repo.
//
// A reviewer's whole verification is then:
//   git checkout <tag> && npm ci --ignore-scripts && npm run build
//   npm run build:plugin && npm run verify:plugin
// and a mismatch names the exact file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(repo, 'plugin');
const manifestFile = path.join(repo, 'plugin.sha256');
const write = process.argv.includes('--write');

if (!fs.existsSync(pluginDir)) {
  process.stderr.write('verify-plugin: plugin/ is not built — run `npm run build:plugin`\n');
  process.exit(1);
}

/** Every file under plugin/, repo-relative, sorted for a stable manifest. */
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const lines = walk(pluginDir).map((file) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `${hash}  ${path.relative(repo, file)}`;
});
const actual = lines.join('\n') + '\n';

if (write) {
  fs.writeFileSync(manifestFile, actual, 'utf8');
  process.stdout.write(`verify-plugin: wrote plugin.sha256 (${lines.length} files)\n`);
  process.exit(0);
}

if (!fs.existsSync(manifestFile)) {
  process.stderr.write(
    'verify-plugin: plugin.sha256 is missing. It is the ONLY thing that makes the\n' +
    'committed bundle auditable (§16.8) — generate it with `npm run verify:plugin -- --write`\n',
  );
  process.exit(1);
}

const expected = fs.readFileSync(manifestFile, 'utf8');
if (expected === actual) {
  process.stdout.write(`verify-plugin ok — ${lines.length} files match plugin.sha256\n`);
  process.exit(0);
}

// Name the exact files, because "the hashes differ" is not actionable.
const parse = (text) => new Map(
  text.split('\n').filter(Boolean).map((l) => {
    const [hash, ...rest] = l.split('  ');
    return [rest.join('  '), hash];
  }),
);
const exp = parse(expected);
const act = parse(actual);
const problems = [];
for (const [file, hash] of act) {
  if (!exp.has(file)) problems.push(`  added:    ${file}`);
  else if (exp.get(file) !== hash) problems.push(`  CHANGED:  ${file}`);
}
for (const file of exp.keys()) if (!act.has(file)) problems.push(`  removed:  ${file}`);

process.stderr.write(
  'verify-plugin FAILED (spec §16.8): the built plugin does not match plugin.sha256.\n' +
  problems.join('\n') +
  '\n\nIf this build is intentional, re-record it with `npm run verify:plugin -- --write`\n' +
  'in the SAME release commit that updates plugin/ — never separately.\n',
);
process.exit(1);
