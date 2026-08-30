// P5-02 — the deterministic binding checker (spec §3.8).
//
// The pure half is tested in bindings.test.ts. This file tests the ONE thing
// that half cannot: what happens when the ref meets a real tree. So every test
// here builds an actual fixture tree in a temp directory — files that exist,
// files that do not, a directory, a short file cited past its end, a traversal
// attempt and a symlink out of the tree — and asserts what the checker says
// about each. A checker that reports a citation as verified without opening
// anything would pass a mocked test and fail the only job it has.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countLines,
  isInside,
  resolveBindings,
  type BindingStatus,
  type GBinding,
} from '../src/index.js';
import { doc, edge, node } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function temp(prefix: string): string {
  // realpath: /tmp is a symlink to /private/tmp on macOS, and a test that
  // compared an un-realpathed root against a realpathed child would report
  // every binding as escaped for reasons that have nothing to do with the code.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The fixture tree every test below resolves against:
 *
 *   <root>/internal/pay.go            5 lines
 *   <root>/short.txt                  2 lines, no trailing newline
 *   <root>/empty.txt                  0 bytes
 *   <root>/docker-compose.yml         1 line
 *   <root>/services/orders/           a directory (with a file in it)
 *   <root>/links/escape.txt   -> <outside>/secret.txt      symlink out of the tree
 *   <root>/escape-dir         -> <outside>                 symlink out of the tree
 *   <root>/links/inside.go    -> <root>/internal/pay.go    symlink within the tree
 *   <root>/links/dangling.txt -> <root>/gone.txt           symlink to nothing
 *
 * The symlinks live under links/ because a ref with no "/" and no known
 * extension is an IDENTIFIER (ref.ts), not a path — `escape` would have been
 * reported as unchecked and the security test would have proved nothing.
 *
 * `outside` is a sibling temp directory, so "outside the root" is literally
 * true rather than arranged by a string.
 */
function fixtureTree(): { root: string; outside: string } {
  const root = temp('diagram-bindings-root-');
  const outside = temp('diagram-bindings-outside-');

  fs.mkdirSync(path.join(root, 'internal'), { recursive: true });
  fs.writeFileSync(path.join(root, 'internal', 'pay.go'), 'a\nb\nc\nd\ne\n');
  fs.writeFileSync(path.join(root, 'short.txt'), 'one\ntwo');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n');
  fs.mkdirSync(path.join(root, 'services', 'orders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services', 'orders', 'main.go'), 'package main\n');

  fs.writeFileSync(path.join(outside, 'secret.txt'), 'ssh-rsa AAAA\n');
  fs.mkdirSync(path.join(root, 'links'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'links', 'escape.txt'));
  fs.symlinkSync(outside, path.join(root, 'escape-dir'));
  fs.symlinkSync(path.join(root, 'internal', 'pay.go'), path.join(root, 'links', 'inside.go'));
  fs.symlinkSync(path.join(root, 'gone.txt'), path.join(root, 'links', 'dangling.txt'));

  return { root, outside };
}

/** A one-node document carrying exactly the given bindings. */
function withBindings(...bindings: GBinding[]) {
  return doc({ nodes: [node('orders', { bindings })] });
}

/** Resolve one binding and hand back just its status and reason. */
function one(root: string, binding: GBinding): { status: BindingStatus; reason: string } {
  const report = resolveBindings(withBindings(binding), root);
  const r = report.results[0];
  if (r === undefined) throw new Error('no result');
  return { status: r.status, reason: r.reason };
}

// ---------------------------------------------------------------------------
// Line counting
// ---------------------------------------------------------------------------

describe('countLines', () => {
  it('counts an empty file as zero lines, so line 1 on it is stale', () => {
    expect(countLines(Buffer.from(''))).toBe(0);
  });

  it('counts a final unterminated line the way an editor does', () => {
    expect(countLines(Buffer.from('one\ntwo'))).toBe(2);
    expect(countLines(Buffer.from('one\ntwo\n'))).toBe(2);
  });

  it('counts bytes, so a non-UTF-8 file does not throw or miscount', () => {
    expect(countLines(Buffer.from([0xff, 0x0a, 0xfe, 0x0a]))).toBe(2);
  });
});

describe('isInside', () => {
  it('is not fooled by a sibling whose name starts with the root', () => {
    // The bug this exists to prevent: "/repo-backup".startsWith("/repo").
    expect(isInside('/repo', '/repo-backup/x')).toBe(false);
    expect(isInside('/repo', '/repo/x')).toBe(true);
    expect(isInside('/repo', '/repo')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolution against a real tree
// ---------------------------------------------------------------------------

describe('resolveBindings against a real tree', () => {
  it('verifies a file that is there', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'internal/pay.go' })).toEqual({
      status: 'ok',
      reason: '',
    });
  });

  it('verifies a directory ref, and never counts lines in it', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'services/orders/' }).status).toBe('ok');
  });

  it('reports a path that is not there as missing', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'services/billing/main.go' })).toEqual({
      status: 'missing',
      reason: 'no such path',
    });
  });

  it('reports a trailing-slash ref that turns out to be a file as stale', () => {
    // The ref makes a positive claim ("this is a directory") and the tree
    // contradicts it. The reverse — no slash, and it IS a directory — is
    // accepted, because `services/orders` claims nothing either way.
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'internal/pay.go/' })).toEqual({
      status: 'stale',
      reason: 'not a directory',
    });
    expect(one(root, { source: 'repo', ref: 'services/orders' }).status).toBe('ok');
  });

  it('reports a line past the end of the file as stale, and says how long it is', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'internal/pay.go', line: 412 })).toEqual({
      status: 'stale',
      reason: 'file has 5 lines',
    });
    // The boundary: the last line of the file resolves, one past it does not.
    expect(one(root, { source: 'repo', ref: 'internal/pay.go', line: 5 }).status).toBe('ok');
    expect(one(root, { source: 'repo', ref: 'internal/pay.go', line: 6 }).status).toBe('stale');
  });

  it('says "1 line" rather than "1 lines"', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'compose', ref: 'docker-compose.yml', line: 9 }).reason).toBe(
      'file has 1 line',
    );
  });

  it('treats an empty file as having no lines at all', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'empty.txt', line: 1 })).toEqual({
      status: 'stale',
      reason: 'file has 0 lines',
    });
  });

  it('counts a final unterminated line, so short.txt:2 resolves', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'short.txt', line: 2 }).status).toBe('ok');
    expect(one(root, { source: 'repo', ref: 'short.txt', line: 3 }).status).toBe('stale');
  });

  it('reports a line cited on a directory as stale rather than resolving it', () => {
    // V16 keeps a line off a TRAILING-SLASH ref, but `services/orders:12`
    // validates — the pure half refuses to guess what an extensionless path
    // is. This is where it finds out, and it must not read the directory.
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'services/orders', line: 12 })).toEqual({
      status: 'stale',
      reason: 'is a directory, so line 12 cites nothing',
    });
  });
});

// ---------------------------------------------------------------------------
// The security boundary
// ---------------------------------------------------------------------------

describe('resolveBindings refuses to leave the root', () => {
  it('never resolves a traversal ref, and never reports it as ok', () => {
    // V16 rejects "../.." on every write path, so a document containing one
    // was hand-edited past validation. The checker still refuses it: two locks
    // on a door onto the developer's home directory is the right number.
    const { root, outside } = fixtureTree();
    const escape = path.relative(root, path.join(outside, 'secret.txt'));
    expect(escape.startsWith('..')).toBe(true);
    const result = one(root, { source: 'repo', ref: escape });
    expect(result.status).toBe('malformed');
    expect(result.reason).toBe('ref escapes the root with ".."');
  });

  it('reports an absolute ref as malformed rather than opening it', () => {
    const { root, outside } = fixtureTree();
    const result = one(root, { source: 'repo', ref: path.join(outside, 'secret.txt') });
    expect(result.status).toBe('malformed');
    expect(result.reason).toBe('ref is an absolute path, not repo-relative');
  });

  it('catches a symlink that points out of the tree', () => {
    // The one no amount of string handling can see: the ref is a perfectly
    // ordinary repo-relative path and the file it names is real. Only
    // realpath tells you it is somebody else's file.
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'links/escape.txt' })).toEqual({
      status: 'escaped',
      reason: 'symlink resolves outside the root',
    });
  });

  it('catches a path THROUGH a symlinked directory that leaves the tree', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'escape-dir/secret.txt' }).status).toBe('escaped');
  });

  it('still accepts a symlink that stays inside the tree', () => {
    // Refusing every symlink would fail a monorepo that links its packages,
    // so the test is where it POINTS, not whether it is a link.
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'links/inside.go', line: 5 }).status).toBe('ok');
  });

  it('reports a dangling symlink as missing, not as escaped', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'links/dangling.txt' })).toEqual({
      status: 'missing',
      reason: 'no such path',
    });
  });

  it('reports a URL ref as malformed rather than fetching anything', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'https://example.com/pay.go' })).toEqual({
      status: 'malformed',
      reason: 'ref is a URL, not a repo-relative path',
    });
  });
});

// ---------------------------------------------------------------------------
// Honesty about what cannot be checked
// ---------------------------------------------------------------------------

describe('an identifier is unchecked, never ok', () => {
  it('does not try to resolve a compose service key as a file', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'compose', ref: 'orders-api' })).toEqual({
      status: 'unchecked',
      reason: 'identifier, not a path — nothing on disk to resolve',
    });
  });

  it('does not report a terraform address as missing', () => {
    // The failure mode this whole feature exists to prevent, in miniature: a
    // correct citation reported as a broken one, because the checker guessed
    // that a dot means a file extension.
    const { root } = fixtureTree();
    expect(one(root, { source: 'terraform', ref: 'aws_ecs_service.orders' }).status).toBe(
      'unchecked',
    );
  });

  it('does not fail the run', () => {
    const { root } = fixtureTree();
    const report = resolveBindings(
      withBindings({ source: 'compose', ref: 'orders-api' }),
      root,
    );
    expect(report.ok).toBe(true);
    expect(report.counts.unchecked).toBe(1);
    expect(report.counts.ok).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

describe('the report as a whole', () => {
  it('counts elements and bindings, and walks nodes then edges in document order', () => {
    const { root } = fixtureTree();
    const d = doc({
      nodes: [
        node('orders', {
          bindings: [
            { source: 'repo', ref: 'internal/pay.go', line: 5 },
            { source: 'compose', ref: 'orders-api' },
          ],
        }),
        node('billing'),
      ],
      edges: [
        edge('e7', 'orders', 'billing', {
          bindings: [{ source: 'repo', ref: 'internal/pay.go', line: 412 }],
        }),
      ],
    });
    const report = resolveBindings(d, root);
    expect(report.elements).toBe(2);
    expect(report.bindings).toBe(3);
    expect(report.results.map((r) => `${r.kind}:${r.id}:${r.status}`)).toEqual([
      'node:orders:ok',
      'node:orders:unchecked',
      'edge:e7:stale',
    ]);
    expect(report.ok).toBe(false);
  });

  it('is deterministic: the same document and tree give byte-identical results twice', () => {
    const { root } = fixtureTree();
    const d = withBindings(
      { source: 'repo', ref: 'internal/pay.go', line: 5 },
      { source: 'compose', ref: 'orders-api' },
    );
    expect(JSON.stringify(resolveBindings(d, root))).toBe(
      JSON.stringify(resolveBindings(d, root)),
    );
  });

  it('blames the root, once, when the root itself does not exist', () => {
    // Twenty-two "missing" rows when the real problem is one wrong --root is
    // how a checker talks an agent into deleting correct citations.
    const { root } = fixtureTree();
    const report = resolveBindings(
      withBindings(
        { source: 'repo', ref: 'internal/pay.go' },
        { source: 'compose', ref: 'orders-api' },
      ),
      path.join(root, 'no-such-dir'),
    );
    expect(report.results.map((r) => r.reason)).toEqual([
      'the root itself does not exist',
      'identifier, not a path — nothing on disk to resolve',
    ]);
    expect(report.ok).toBe(false);
  });

  it('reports a document with no bindings as empty and passing', () => {
    const { root } = fixtureTree();
    const report = resolveBindings(doc({ nodes: [node('orders')] }), root);
    expect(report).toMatchObject({ elements: 0, bindings: 0, ok: true });
    expect(report.results).toEqual([]);
  });

  it('records nothing about a running system (R5)', () => {
    // A binding says where a claim was READ. No timestamp, no health, no
    // "last checked" may appear on a result, or the document's one hard
    // promise stops being true the moment someone serialises a report.
    const { root } = fixtureTree();
    const report = resolveBindings(
      withBindings({ source: 'repo', ref: 'internal/pay.go' }),
      root,
    );
    const keys = Object.keys(report.results[0] as object).sort();
    expect(keys).toEqual(['formatted', 'id', 'kind', 'reason', 'status']);
  });
});
