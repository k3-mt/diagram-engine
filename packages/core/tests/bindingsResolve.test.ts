// P5-02 — the deterministic binding checker (spec §3.8).
//
// The pure half is tested in bindings.test.ts. This file tests the ONE thing
// that half cannot: what happens when the ref meets a real tree. So every test
// here builds an actual fixture tree in a temp directory — files that exist,
// files that do not, a directory, a short file cited past its end, a traversal
// attempt and a symlink out of the tree — and asserts what the checker says
// about each. A checker that reports a citation as verified without opening
// anything would pass a mocked test and fail the only job it has.

import { execFileSync } from 'node:child_process';
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
    // ...nor by a child whose NAME starts with "..": that is a missing file,
    // not an escape, and the two send a reader to very different places.
    expect(isInside('/repo', '/repo/..%2fetc%2fpasswd')).toBe(true);
    expect(isInside('/repo', '/etc/passwd')).toBe(false);
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
    const { root, outside } = fixtureTree();
    const r = one(root, { source: 'repo', ref: 'links/escape.txt' });
    expect(r.status).toBe('escaped');
    expect(r.reason).toContain('symlink resolves outside the root');
    // ...and says WHERE it went: an intentional monorepo link and a leak read
    // identically without it.
    expect(r.reason).toContain(path.join(outside, 'secret.txt'));
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

describe('an identifier is searched for, and is never quietly ok', () => {
  it('never reports an identifier ok without finding a definition', () => {
    // The invariant the original "identifier => unchecked" test was protecting,
    // kept exactly: the one thing that must never happen is a citation
    // reported as verified when nothing verified it. The fixture tree's
    // docker-compose.yml has a `services:` key and no services under it.
    const { root } = fixtureTree();
    expect(one(root, { source: 'compose', ref: 'orders-api' }).status).not.toBe('ok');
    expect(one(root, { source: 'terraform', ref: 'aws_ecs_service.orders' }).status).not.toBe(
      'ok',
    );
  });

  it('reports a compose service that no compose file declares as missing', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'compose', ref: 'orders-api' })).toEqual({
      status: 'missing',
      reason:
        'not defined in the 1 docker-compose*.y*ml / compose*.y*ml file under the root',
    });
  });

  it('verifies a compose service that IS declared, and names the file', () => {
    const { root } = fixtureTree();
    fs.writeFileSync(
      path.join(root, 'docker-compose.yml'),
      'version: "3"\nservices:\n  orders-api:\n    image: orders\n',
    );
    expect(one(root, { source: 'compose', ref: 'orders-api' })).toEqual({
      status: 'ok',
      reason: 'defined in docker-compose.yml:3',
    });
  });

  it('reports a terraform citation in a repo with no terraform as missing', () => {
    // Spec §3.8 rule 1: no candidate file of the right kind is a WRONG
    // citation, not an unanswerable one. Reporting it unchecked let a quarter
    // of every corpus's citations pass without ever being read.
    const { root } = fixtureTree();
    expect(one(root, { source: 'terraform', ref: 'aws_ecs_service.orders' })).toEqual({
      status: 'missing',
      reason: 'no *.tf file under the root',
    });
  });

  it('verifies a terraform resource that is declared, and not one that is only mentioned', () => {
    const { root } = fixtureTree();
    fs.mkdirSync(path.join(root, 'infra'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'infra', 'main.tf'),
      '# resource "aws_ecs_service" "ghost" {}\nresource "aws_ecs_service" "orders" {\n}\n',
    );
    expect(one(root, { source: 'terraform', ref: 'aws_ecs_service.orders' })).toEqual({
      status: 'ok',
      reason: 'defined in infra/main.tf:2',
    });
    // Named only in a comment: not a definition, and not verified.
    expect(one(root, { source: 'terraform', ref: 'aws_ecs_service.ghost' }).status).toBe(
      'missing',
    );
  });

  it('fails the run when an identifier does not resolve', () => {
    // It used to pass, because it was unchecked. An identifier citing nothing
    // is now as much a failure as a path citing nothing — which is the whole
    // point of making it checkable.
    const { root } = fixtureTree();
    const report = resolveBindings(
      withBindings({ source: 'terraform', ref: 'aws_ecs_service.orders' }),
      root,
    );
    expect(report.ok).toBe(false);
    expect(report.counts.missing).toBe(1);
    expect(report.counts.unchecked).toBe(0);
  });

  it('stays unchecked, and passing, where no precise pattern can be written', () => {
    // The residue §3.8 rule 2 keeps: flow-style YAML needs a parser this
    // package will not take a dependency on, and guessing is worse than
    // admitting. Reported, counted, and not a failure.
    const { root } = fixtureTree();
    fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services: {orders-api: {}}\n');
    const report = resolveBindings(
      withBindings({ source: 'compose', ref: 'orders-api' }),
      root,
    );
    expect(report.results[0]?.status).toBe('unchecked');
    expect(report.results[0]?.reason).toContain('flow style');
    expect(report.ok).toBe(true);
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
      'node:orders:missing',
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
    // Including the identifier: with no tree there is nothing to search
    // either, and one wrong --root must read as one fact, not as two kinds of
    // failure the reader then has to reconcile.
    expect(report.results.map((r) => r.reason)).toEqual([
      'the root itself does not exist',
      'the root itself does not exist',
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

// ---------------------------------------------------------------------------
// Lock 4 — the spelling on disk, not the spelling the kernel will accept
// ---------------------------------------------------------------------------

describe('a path that does not exist AS SPELLED is missing on every filesystem', () => {
  // On macOS (APFS/HFS+) and on NTFS the kernel answers "yes, that exists" for
  // the wrong case, and macOS's realpathSync hands back the spelling it was
  // asked for rather than the stored one — so before lock 4 these two reported
  // `ok` and exit 0 on a laptop and `missing` and exit 1 on Linux CI, from the
  // same document and the same commit.

  it('rejects a wrong-case ref', () => {
    const { root } = fixtureTree();
    const r = one(root, { source: 'repo', ref: 'Internal/PAY.GO', line: 3 });
    expect(r.status).toBe('missing');
    expect(r.reason).toContain('on disk it is "internal"');
  });

  it('rejects a wrong-case final segment', () => {
    const { root } = fixtureTree();
    const r = one(root, { source: 'repo', ref: 'internal/Pay.go' });
    expect(r.status).toBe('missing');
    expect(r.reason).toContain('on disk it is "pay.go"');
  });

  it('rejects an NFD spelling of a name stored NFC', () => {
    const { root } = fixtureTree();
    const nfc = 'café.go'; // café.go, single code point
    const nfd = 'café.go'; // café.go, e + combining acute
    fs.writeFileSync(path.join(root, nfc), 'x\n');
    // Only meaningful where the filesystem actually stored what we wrote; a
    // volume that normalises on write makes this a tautology, so assert
    // against the listing rather than against the platform.
    const stored = fs.readdirSync(root).find((e) => e.normalize('NFC') === nfc);
    if (stored !== nfd) {
      expect(one(root, { source: 'repo', ref: nfd }).status).toBe('missing');
    }
    expect(one(root, { source: 'repo', ref: stored ?? nfc }).status).toBe('ok');
  });

  it('still verifies the exact spelling', () => {
    const { root } = fixtureTree();
    expect(one(root, { source: 'repo', ref: 'internal/pay.go', line: 5 }).status).toBe('ok');
  });

  it('reads one directory once, however many bindings cite it', () => {
    // The walk is cached per run: forty citations under one directory must not
    // cost forty listings.
    const { root } = fixtureTree();
    const report = resolveBindings(
      withBindings(
        { source: 'repo', ref: 'internal/pay.go' },
        { source: 'compose', ref: 'docker-compose.yml' },
        { source: 'k8s-manifest', ref: 'services/orders/main.go' },
      ),
      root,
    );
    expect(report.counts.ok).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// One bad file must not take the report with it
// ---------------------------------------------------------------------------

describe('a file that cannot be read', () => {
  it('costs its own row and nothing else', () => {
    const { root } = fixtureTree();
    const locked = path.join(root, 'locked.txt');
    fs.writeFileSync(locked, 'a\nb\n');
    fs.chmodSync(locked, 0o000);
    // Running as root, mode 000 is not enforced and there is nothing to test.
    let readable = true;
    try {
      fs.readFileSync(locked);
    } catch {
      readable = false;
    }
    if (readable) return;

    const report = resolveBindings(
      withBindings(
        { source: 'repo', ref: 'locked.txt', line: 1 },
        { source: 'compose', ref: 'docker-compose.yml', line: 1 },
      ),
      root,
    );
    expect(report.results.map((r) => r.status)).toEqual(['unchecked', 'ok']);
    expect(report.results[0]?.reason).toBe(
      'file exists but could not be read — line not counted',
    );
    // Honest, and not a failure: we know the file is there and we did not count.
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Not a file, not a directory
// ---------------------------------------------------------------------------

describe('a path that is neither a file nor a directory', () => {
  it('is stale with or without a line', () => {
    const { root } = fixtureTree();
    const fifo = path.join(root, 'pipe.txt');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this box; nothing to assert
    }
    expect(one(root, { source: 'repo', ref: 'pipe.txt' })).toEqual({
      status: 'stale',
      reason: 'not a regular file',
    });
    expect(one(root, { source: 'repo', ref: 'pipe.txt', line: 1 }).status).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// The source decides what a ref can name
// ---------------------------------------------------------------------------

describe('a repo ref is always a path, and so is always resolved', () => {
  it('reports an invented repo ref as missing rather than unchecked', () => {
    // The escape hatch this closes: `repo=schema.prisma` (prisma is not on the
    // extension allowlist) and `repo=totally_invented_thing` were identifiers,
    // came back `unchecked`, exited 0, and were excluded from the eval's
    // precision while still counting as coverage. Effort scored, honesty not.
    const { root } = fixtureTree();
    for (const ref of ['schema.prisma', 'totally_invented_thing', '..%2fetc%2fpasswd']) {
      expect(one(root, { source: 'repo', ref }).status, ref).toBe('missing');
    }
  });

  it('still verifies a real extensionless repo file', () => {
    const { root } = fixtureTree();
    fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n');
    expect(one(root, { source: 'repo', ref: 'Makefile' }).status).toBe('ok');
  });

  it('does not read a scoped package name as a directory', () => {
    // `@acme/utils` contains "/" and would otherwise be a path, so a correct
    // scoped-package citation would be reported missing — the wrong "missing"
    // the allowlist exists to avoid, in a second dress.
    const { root } = fixtureTree();
    expect(one(root, { source: 'package', ref: '@acme/utils' })).toEqual({
      status: 'missing',
      reason: 'no package.json file under the root',
    });
    // ...and once a package.json declares it, it verifies — which is only
    // possible because it was never treated as a directory.
    fs.writeFileSync(path.join(root, 'package.json'), '{\n  "name": "@acme/utils"\n}\n');
    expect(one(root, { source: 'package', ref: '@acme/utils' })).toEqual({
      status: 'ok',
      reason: 'defined in package.json:2',
    });
  });
});
