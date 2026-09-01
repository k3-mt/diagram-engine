// scripts/eval/stage.mjs — the anti-leak half of the M8 eval harness
// (BUILD.md P3-05). This module exists for one property:
//
//   THE AGENT UNDER TEST MUST NEVER BE ABLE TO REACH THE ANSWER KEY.
//
// An eval that shows the model its own answer key measures nothing, and the
// answer key lives INSIDE the reference system it is asked to read:
// fixtures/ref-a/gold.json, gold-citations.md and PLANTED.md sit in the same
// directory as docker-compose.yml. Pointing an agent at fixtures/ref-a/ and
// hoping it does not open PLANTED.md is not a guarantee, it is a wish.
//
// So the harness never points the agent at the repository at all. It copies
// the reference system into a fresh temp directory, file by file, refusing to
// copy anything on the denylist, and then AUDITS the result: it walks the
// staged tree and throws if any file is on the denylist, contains a leak
// marker, or is a symlink that could be followed back out to the repo. Copy
// and audit are separate passes on purpose — the audit does not trust the
// copier, so a future edit to the denylist that misses a new answer-key file
// fails loudly instead of silently scoring a leaked run.
//
// The scoring half never runs in the agent's process: gold is read by the
// harness AFTER the agent has exited, from the repository, and its path is
// passed to no subprocess the agent can see.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Files that are the answer key, or point at it. Matched case-insensitively
 * against the BASENAME, so a copy nested anywhere in the tree is caught too.
 */
export const DENY_BASENAMES = [
  /^gold\.json$/i,
  /^gold-.*\.md$/i,
  /^gold\..*$/i,
  /^planted\.md$/i,
  /^planted-.*$/i,
  /^eval-.*\.json$/i,
  // Fixture scaffolding, not part of the modelled system: fixtures/ref-b/verify.sh
  // is the P3-03 structural check and it greps PLANTED.md by name, so it both
  // points at the answer key and names it. The audit caught it the first time
  // this harness ran; the denylist is where that verdict is recorded.
  /^verify\.sh$/i,
];

/**
 * Text that must not appear in any staged file. These are the words the
 * answer key is written in; a fixture that legitimately needed one of them
 * would have to be renamed, which is the correct trade for this property.
 */
export const LEAK_MARKERS = [
  'PLANTED.md',
  'gold.json',
  'gold-citations',
  'the planted',
  'planted item',
  'answer key',
  // A fixture must never tell the agent it is a fixture. fixtures/ref-b/go.mod
  // opened with "Reference system B for the diagram-engine eval rig (BUILD.md
  // P3-03)" and was staged verbatim into the agent's cwd for every system-B
  // run: three disclosures at once — that it is being scored (which changes
  // behaviour on the axis being measured), the repository name (the search term
  // that turns "could the agent find the key" into two Glob calls), and the
  // file that describes the whole rig. None of the markers above matched it.
  'eval rig',
  'eval harness',
  'reference system',
  'BUILD.md',
  'agent under test',
];

/**
 * Markers that apply to the STAGED FIXTURE ONLY, not to the whole workspace.
 * The repository's own name is the search term that turns "could the agent find
 * the answer key" into two Glob calls, so no fixture file may contain it — but
 * `diagram init` writes `<!-- diagram-engine:begin -->` sentinels into the
 * workspace's CLAUDE.md and .gitignore, and those are the product's own markers,
 * not a leak. Hence two scopes rather than one list.
 */
export const FIXTURE_ONLY_MARKERS = () => [repoName()];

/** Directories never worth copying into a scratch workspace. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.diagram']);

export function isDenied(basename) {
  return DENY_BASENAMES.some((re) => re.test(basename));
}

/** Every file under `root`, relative, sorted — deterministic. */
export function walk(root, rel = '', out = []) {
  const dir = path.join(root, rel);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, r, out);
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Copy `src` to `dest`, dropping denylisted files and never following a
 * symlink. Returns { copied, skipped }.
 */
export function stage(src, dest) {
  const copied = [];
  const skipped = [];
  const recurse = (rel) => {
    const from = path.join(src, rel);
    for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        // A symlink is the one way a staged tree can point back at the repo.
        skipped.push({ path: r, why: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped.push({ path: r, why: 'skipped directory' });
          continue;
        }
        fs.mkdirSync(path.join(dest, r), { recursive: true });
        recurse(r);
        continue;
      }
      if (isDenied(entry.name)) {
        skipped.push({ path: r, why: 'answer key (denylist)' });
        continue;
      }
      fs.copyFileSync(path.join(src, r), path.join(dest, r));
      copied.push(r);
    }
  };
  fs.mkdirSync(dest, { recursive: true });
  recurse('');
  return { copied, skipped };
}

/**
 * The name of the repository the rig lives in, derived rather than hard-coded:
 * a staged file that names it hands the agent the one search term it needs.
 * `audit()` adds it to the marker list automatically.
 *
 * TAKEN FROM package.json, NOT THE DIRECTORY NAME. The basename of the
 * checkout is an incidental local path, and markers are matched as plain
 * substrings, so deriving from it made the test suite's result depend on what
 * the developer happened to call their clone: checking out into `~/fresh`
 * fails ten tests, because fixtures/ref-a/.../auth-client.js says "refresh"
 * and "refresh" contains "fresh". The package name is the repository's actual
 * identity and is the same on every machine — which is also the string a
 * staged file could realistically leak.
 *
 * Falls back to the directory name only if package.json cannot be read, since
 * a marker list that silently loses an entry is worse than an imperfect one.
 */
export function repoName(from = new URL('../..', import.meta.url).pathname) {
  const root = path.resolve(from);
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name !== '') return name;
  } catch {
    /* fall through to the directory name */
  }
  return path.basename(root);
}

/**
 * Prove the staged tree carries no answer key. Returns the list of problems;
 * an empty list is the only acceptable result and the caller must treat a
 * non-empty one as fatal.
 *
 * This is deliberately a SECOND, independent pass: it re-derives the verdict
 * from the files that are actually on disk rather than from what stage()
 * believes it copied.
 */
export function audit(root, extraMarkers = []) {
  const problems = [];
  const markers = [...new Set([...LEAK_MARKERS, ...extraMarkers])];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = path.join(root, rel);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        problems.push(`${r}: symlink in the staged tree (could resolve back into the repository)`);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(r);
        continue;
      }
      if (isDenied(entry.name)) {
        problems.push(`${r}: answer-key file present in the agent's workspace`);
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(path.join(root, r), 'utf8');
      } catch {
        continue; // unreadable or binary; nothing quotable in it
      }
      for (const m of markers) {
        if (text.toLowerCase().includes(m.toLowerCase())) {
          problems.push(`${r}: contains the leak marker "${m}"`);
        }
      }
    }
  }
  return problems.sort();
}

/** Stage + audit in one call. Throws on any leak. */
export function stageAndAudit(src, dest) {
  const result = stage(src, dest);
  const problems = audit(dest, FIXTURE_ONLY_MARKERS());
  if (problems.length) {
    throw new Error(
      `gold leak into the agent workspace — refusing to run:\n  ${problems.join('\n  ')}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI:  node scripts/eval/stage.mjs <src> <dest>   stage + audit
//       node scripts/eval/stage.mjs --audit <dir>  audit an existing tree
// prints one line per skipped file, then "staged N files, audit clean".
// ---------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('stage.mjs')) {
  const [src, dest] = process.argv.slice(2);
  if (src === '--audit') {
    if (!dest) {
      process.stderr.write('usage: node scripts/eval/stage.mjs --audit <dir>\n');
      process.exit(2);
    }
    const problems = audit(dest);
    if (problems.length) {
      process.stderr.write(`gold leak in ${dest}:\n  ${problems.join('\n  ')}\n`);
      process.exit(1);
    }
    process.stdout.write('  workspace leak audit clean\n');
    process.exit(0);
  }
  if (!src || !dest) {
    process.stderr.write('usage: node scripts/eval/stage.mjs <reference-system-dir> <staging-dir>\n');
    process.exit(2);
  }
  try {
    const { copied, skipped } = stageAndAudit(src, dest);
    for (const s of skipped) process.stdout.write(`  withheld: ${s.path} (${s.why})\n`);
    process.stdout.write(`  staged ${copied.length} files, leak audit clean\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
