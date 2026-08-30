// The bounded search for identifier definitions (spec §3.8), against a real
// tree. The matchers are tested on strings in bindingsIdentifier.test.ts; this
// file tests the half that cannot be tested that way — which files are walked,
// which are refused, and what happens AT the bound.
//
// The bound gets a test of its own because a cap is a correctness feature, not
// a performance one: a search that silently gave up would turn a real citation
// into a false `missing`, and a false `missing` is the failure mode the whole
// feature exists to prevent. So hitting it must downgrade the verdict to
// `unchecked`, and this file proves it does.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_LIMITS,
  IdentifierSearch,
  MAX_CANDIDATE_FILE_BYTES,
  MAX_CANDIDATE_FILES,
  MAX_WALK_ENTRIES,
  SKIP_DIRECTORIES,
  indexCandidateFiles,
  resolveBindings,
  type SearchLimits,
} from '../src/index.js';
import { doc, node } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function temp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root: string, rel: string, text: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

/** `<root>` with a small, realistic repository in it. */
function repo(): string {
  const root = temp('diagram-search-');
  write(root, 'infra/main.tf', 'resource "aws_ecs_service" "orders" {\n}\n');
  write(root, 'docker-compose.yml', 'services:\n  orders-api:\n    image: acme/orders\n');
  write(root, 'package.json', '{\n  "name": "@acme/orders"\n}\n');
  write(root, 'deploy/orders.yaml', 'kind: Deployment\nmetadata:\n  name: orders\n');
  // The decoys: files of the right kind, in directories nobody means.
  write(root, 'node_modules/x/main.tf', 'resource "aws_ecs_service" "vendored" {\n}\n');
  write(root, 'dist/deploy.yaml', 'kind: Deployment\nmetadata:\n  name: built\n');
  write(root, '.git/config.yaml', 'kind: Deployment\nmetadata:\n  name: gitish\n');
  return root;
}

const rel = (root: string, files: readonly string[]): string[] =>
  files.map((f) => path.relative(root, f)).sort();

describe('indexCandidateFiles', () => {
  it('finds each source only in the files that source can live in', () => {
    const root = repo();
    const index = indexCandidateFiles(root);
    expect(rel(root, index.files.terraform)).toEqual(['infra/main.tf']);
    expect(rel(root, index.files.compose)).toEqual(['docker-compose.yml']);
    expect(rel(root, index.files.package)).toEqual(['package.json']);
    // Every YAML is a possible manifest — including the compose file, which is
    // simply not a manifest when it is read.
    expect(rel(root, index.files['k8s-manifest'])).toEqual([
      'deploy/orders.yaml',
      'docker-compose.yml',
    ]);
    expect(index.truncated).toBe(false);
  });

  it('never enters node_modules, dist or .git', () => {
    const root = repo();
    const index = indexCandidateFiles(root);
    const all = Object.values(index.files).flat().join('\n');
    expect(all).not.toContain('node_modules');
    expect(all).not.toContain('dist');
    expect(all).not.toContain('.git');
    for (const skipped of ['node_modules', '.git', 'dist']) {
      expect(SKIP_DIRECTORIES.has(skipped)).toBe(true);
    }
  });

  it('is deterministic: the same tree gives the same list, in the same order', () => {
    const root = repo();
    write(root, 'infra/b.tf', 'resource "aws_ecs_service" "b" {}\n');
    write(root, 'infra/a.tf', 'resource "aws_ecs_service" "a" {}\n');
    const once = indexCandidateFiles(root).files.terraform;
    const twice = indexCandidateFiles(root).files.terraform;
    expect(once).toEqual(twice);
    expect(rel(root, once)).toEqual(['infra/a.tf', 'infra/b.tf', 'infra/main.tf']);
    // Sorted by name within a directory, which is what makes "the first file
    // that matched" a stable answer rather than a readdir accident.
    expect(once.map((f) => path.basename(f))).toEqual(['a.tf', 'b.tf', 'main.tf']);
  });

  it('refuses to follow a symlink out of the root, and cannot be sent in a circle', () => {
    const root = repo();
    const outside = temp('diagram-search-outside-');
    write(outside, 'secret.tf', 'resource "aws_ecs_service" "orders" {}\n');
    fs.symlinkSync(outside, path.join(root, 'linked-out'));
    fs.symlinkSync(path.join(outside, 'secret.tf'), path.join(root, 'linked-file.tf'));
    // A link back to the root: following it twice would never terminate.
    fs.symlinkSync(root, path.join(root, 'infra', 'loop'));

    const index = indexCandidateFiles(root);
    expect(rel(root, index.files.terraform)).toEqual(['infra/main.tf']);
    expect(index.truncated).toBe(false);
  });

  it('stops at the entry cap and says so', () => {
    const root = repo();
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxEntries: 2 };
    const index = indexCandidateFiles(root, limits);
    expect(index.truncated).toBe(true);
    expect(index.entries).toBeLessThanOrEqual(3);
  });

  it('has ceilings that are stated, not implied', () => {
    expect(MAX_WALK_ENTRIES).toBe(20_000);
    expect(MAX_CANDIDATE_FILES).toBe(400);
    expect(MAX_CANDIDATE_FILE_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe('IdentifierSearch.lookup', () => {
  it('verifies each of the four sources against the tree, naming the file', () => {
    const root = repo();
    const search = new IdentifierSearch(root);
    expect(search.lookup('terraform', 'aws_ecs_service.orders')).toEqual({
      status: 'ok',
      reason: 'defined in infra/main.tf:1',
    });
    expect(search.lookup('compose', 'orders-api')).toEqual({
      status: 'ok',
      reason: 'defined in docker-compose.yml:2',
    });
    expect(search.lookup('package', '@acme/orders')).toEqual({
      status: 'ok',
      reason: 'defined in package.json:2',
    });
    expect(search.lookup('k8s-manifest', 'Deployment/orders')).toEqual({
      status: 'ok',
      reason: 'defined in deploy/orders.yaml:3',
    });
  });

  it('does not verify a definition that only exists in a skipped directory', () => {
    // The vendored copy under node_modules declares `aws_ecs_service.vendored`.
    // Crediting a citation to a file the agent could not plausibly have meant
    // is the same failure as crediting one it never opened.
    const root = repo();
    expect(new IdentifierSearch(root).lookup('terraform', 'aws_ecs_service.vendored')).toEqual({
      status: 'missing',
      reason: 'not defined in the 1 *.tf file under the root',
    });
  });

  it('reports a source with no candidate files at all as missing (rule 1)', () => {
    const root = temp('diagram-search-empty-');
    const search = new IdentifierSearch(root);
    expect(search.lookup('terraform', 'aws_ecs_service.orders')).toEqual({
      status: 'missing',
      reason: 'no *.tf file under the root',
    });
    expect(search.lookup('package', '@acme/orders').reason).toBe(
      'no package.json file under the root',
    );
  });

  it('downgrades to unchecked when the bound stopped the search short', () => {
    // The whole reason the cap is reported rather than swallowed: we did not
    // look everywhere, so "it is not there" is a claim we have not earned.
    const root = repo();
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxEntries: 2 };
    const search = new IdentifierSearch(root, limits);
    const got = search.lookup('terraform', 'aws_ecs_service.orders');
    expect(got.status).toBe('unchecked');
    expect(got.reason).toContain('bound');
  });

  it('still verifies what it DID find under a truncated walk', () => {
    // Finding a definition is not made less true by not having looked
    // everywhere. Only the negative answer is weakened by the bound.
    const root = temp('diagram-search-partial-');
    write(root, 'a.tf', 'resource "aws_ecs_service" "orders" {}\n');
    write(root, 'b.tf', 'resource "aws_ecs_service" "other" {}\n');
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFiles: 1 };
    const search = new IdentifierSearch(root, limits);
    expect(search.lookup('terraform', 'aws_ecs_service.orders').status).toBe('ok');
    expect(search.lookup('terraform', 'aws_ecs_service.other').status).toBe('unchecked');
  });

  it('does not open a file over the size ceiling, and does not call it absent', () => {
    const root = temp('diagram-search-big-');
    write(root, 'huge.tf', `${'#\n'.repeat(200)}resource "aws_ecs_service" "orders" {}\n`);
    const limits: SearchLimits = { ...DEFAULT_SEARCH_LIMITS, maxFileBytes: 8 };
    const got = new IdentifierSearch(root, limits).lookup(
      'terraform',
      'aws_ecs_service.orders',
    );
    expect(got.status).toBe('unchecked');
    expect(got.reason).toContain('huge.tf');
  });

  it('reads each candidate file once, however many identifiers are looked up', () => {
    const root = repo();
    const search = new IdentifierSearch(root);
    const before = search.candidates();
    search.lookup('terraform', 'aws_ecs_service.orders');
    search.lookup('terraform', 'aws_ecs_service.nope');
    // The index is built once and reused: the second lookup does not re-walk.
    expect(search.candidates()).toBe(before);
  });
});

describe('resolveBindings, end to end on identifiers', () => {
  it('resolves every source in one walk, and fails only on the wrong citation', () => {
    const root = repo();
    const report = resolveBindings(
      doc({
        nodes: [
          node('orders', {
            bindings: [
              { source: 'terraform', ref: 'aws_ecs_service.orders' },
              { source: 'compose', ref: 'orders-api' },
              { source: 'package', ref: '@acme/orders' },
              { source: 'k8s-manifest', ref: 'Deployment/orders' },
            ],
          }),
          node('ghost', {
            bindings: [{ source: 'terraform', ref: 'aws_ecs_service.invented' }],
          }),
        ],
      }),
      root,
    );
    expect(report.counts).toMatchObject({ ok: 4, missing: 1, unchecked: 0 });
    expect(report.ok).toBe(false);
    expect(report.results[4]?.id).toBe('ghost');
  });

  it('is deterministic over the same tree', () => {
    const root = repo();
    const d = doc({
      nodes: [
        node('orders', {
          bindings: [
            { source: 'compose', ref: 'orders-api' },
            { source: 'k8s-manifest', ref: 'Service/orders' },
          ],
        }),
      ],
    });
    expect(JSON.stringify(resolveBindings(d, root))).toBe(
      JSON.stringify(resolveBindings(d, root)),
    );
  });

  it('builds the index lazily, on the first identifier looked up', () => {
    // A document whose citations are all paths must not pay for a tree walk,
    // so the index is built on first lookup and not in the constructor. Proved
    // by writing a file AFTER the search object exists: it is still found.
    const root = repo();
    const search = new IdentifierSearch(root);
    write(root, 'late.tf', 'resource "aws_ecs_service" "late" {}\n');
    expect(search.lookup('terraform', 'aws_ecs_service.late').status).toBe('ok');
    // ...and once built it is reused, so a later file is NOT picked up. That
    // is what makes one run's answers consistent with each other.
    write(root, 'later.tf', 'resource "aws_ecs_service" "later" {}\n');
    expect(search.lookup('terraform', 'aws_ecs_service.later').status).toBe('missing');
  });
});
