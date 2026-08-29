// M1 Step 5 — the .diagram/ store (spec §2.5, M1 Step 4):
// atomic tmp+rename writes, lock acquisition with the 2s stale takeover,
// missing-file reads, and the on-disk history commit/undo/redo cycle.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  acquireLock,
  commitDoc,
  diagramPaths,
  emptyDoc,
  historyFileName,
  readDoc,
  readPointer,
  redoFromHistory,
  releaseLock,
  resolveDiagramDir,
  undoFromHistory,
  withLock,
  writeDocAtomic,
} from '../src/index.js';
import { doc, node } from './helpers.js';

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-store-test-'));
  tmpDirs.push(dir);
  return path.join(dir, '.diagram');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('paths', () => {
  it('resolveDiagramDir defaults to <cwd>/.diagram and honours DIAGRAM_DIR', () => {
    const prev = process.env['DIAGRAM_DIR'];
    try {
      delete process.env['DIAGRAM_DIR'];
      expect(resolveDiagramDir('/some/project')).toBe('/some/project/.diagram');
      process.env['DIAGRAM_DIR'] = '/elsewhere/.diagram';
      expect(resolveDiagramDir('/some/project')).toBe('/elsewhere/.diagram');
    } finally {
      if (prev === undefined) delete process.env['DIAGRAM_DIR'];
      else process.env['DIAGRAM_DIR'] = prev;
    }
  });
});

describe('read', () => {
  it('a missing graph.json yields the empty document', () => {
    const dir = makeDir();
    const r = readDoc(diagramPaths(dir).graphFile);
    expect(r).toEqual({ ok: true, doc: emptyDoc() });
    expect(emptyDoc()).toMatchObject({ schemaVersion: 1, nodes: [], groups: [], edges: [] });
  });

  it('a present-but-broken file is an error, not an empty doc', () => {
    const dir = makeDir();
    const p = diagramPaths(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p.graphFile, '{ not json', 'utf8');
    const r = readDoc(p.graphFile);
    expect(r.ok).toBe(false);
  });
});

describe('atomic write', () => {
  it('writes complete content and leaves no tmp file behind', () => {
    const dir = makeDir();
    const p = diagramPaths(dir);
    const d = doc({ title: 'Atomic', nodes: [node('auth')] });
    writeDocAtomic(dir, d);
    expect(fs.existsSync(p.graphTmpFile)).toBe(false);
    const r = readDoc(p.graphFile);
    expect(r).toEqual({ ok: true, doc: d });
  });

  it('overwriting leaves either old or new content — the new, once returned', () => {
    const dir = makeDir();
    const p = diagramPaths(dir);
    writeDocAtomic(dir, doc({ title: 'old' }));
    writeDocAtomic(dir, doc({ title: 'new' }));
    expect(fs.existsSync(p.graphTmpFile)).toBe(false);
    const r = readDoc(p.graphFile);
    expect(r.ok && r.doc.title).toBe('new');
  });
});

describe('lock', () => {
  it('fixes the spec constants: 2s stale timeout, 2s wait', () => {
    expect(LOCK_STALE_MS).toBe(2000);
    expect(LOCK_WAIT_MS).toBe(2000);
  });

  it('acquires and releases; a held lock blocks a second acquirer', () => {
    const dir = makeDir();
    fs.mkdirSync(dir, { recursive: true });
    const lockFile = diagramPaths(dir).lockFile;
    acquireLock(lockFile);
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(() => acquireLock(lockFile, { waitMs: 80 })).toThrowError(
      `could not acquire ${lockFile}: held by another process (waited 80ms)`,
    );
    releaseLock(lockFile);
    expect(fs.existsSync(lockFile)).toBe(false);
    // released: can be re-acquired immediately
    acquireLock(lockFile, { waitMs: 80 });
    releaseLock(lockFile);
  });

  it('takes over a stale lock (older than the 2s stale timeout)', () => {
    const dir = makeDir();
    fs.mkdirSync(dir, { recursive: true });
    const lockFile = diagramPaths(dir).lockFile;
    fs.writeFileSync(lockFile, '{"pid":0}', 'utf8');
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lockFile, old, old); // back-date past LOCK_STALE_MS
    acquireLock(lockFile, { waitMs: 100 }); // must not throw
    releaseLock(lockFile);
  });

  it('withLock releases the lock even when the callback throws', () => {
    const dir = makeDir();
    const lockFile = diagramPaths(dir).lockFile;
    expect(() =>
      withLock(dir, () => {
        expect(fs.existsSync(lockFile)).toBe(true);
        throw new Error('boom');
      }),
    ).toThrowError('boom');
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

describe('on-disk history: commit / undo / redo', () => {
  const d1 = doc({ title: 'after patch 1', nodes: [node('auth')] });
  const d2 = doc({ title: 'after patch 2', nodes: [node('auth'), node('postgres')] });
  const d3 = doc({ title: 'after patch 3', nodes: [node('kafka')] });

  it('the first commit seeds the pre-patch state as 0000 so it is undoable', () => {
    const dir = makeDir();
    const p = diagramPaths(dir);
    expect(commitDoc(dir, d1)).toBe(1);
    expect(readPointer(dir)).toBe(1);
    expect(fs.existsSync(path.join(p.historyDir, historyFileName(0)))).toBe(true);
    expect(fs.existsSync(path.join(p.historyDir, historyFileName(1)))).toBe(true);
    const r = readDoc(p.graphFile);
    expect(r.ok && r.doc).toEqual(d1);

    const u = undoFromHistory(dir);
    expect(u.ok && u.doc).toEqual(emptyDoc()); // back to the pre-patch state
    expect(readPointer(dir)).toBe(0);
    const g = readDoc(p.graphFile);
    expect(g.ok && g.doc).toEqual(emptyDoc());
  });

  it('undo bottoms out and redo walks forward again', () => {
    const dir = makeDir();
    commitDoc(dir, d1);
    commitDoc(dir, d2);
    expect(readPointer(dir)).toBe(2);

    const u1 = undoFromHistory(dir);
    expect(u1.ok && u1.doc).toEqual(d1);
    const u2 = undoFromHistory(dir);
    expect(u2.ok && u2.doc).toEqual(emptyDoc());
    const u3 = undoFromHistory(dir);
    expect(u3).toEqual({ ok: false, errors: ['nothing to undo'] });

    const r1 = redoFromHistory(dir);
    expect(r1.ok && r1.doc).toEqual(d1);
    const r2 = redoFromHistory(dir);
    expect(r2.ok && r2.doc).toEqual(d2);
    const r3 = redoFromHistory(dir);
    expect(r3).toEqual({ ok: false, errors: ['nothing to redo'] });
    const g = readDoc(diagramPaths(dir).graphFile);
    expect(g.ok && g.doc).toEqual(d2);
  });

  it('a commit after an undo discards the redo tail', () => {
    const dir = makeDir();
    const p = diagramPaths(dir);
    commitDoc(dir, d1);
    commitDoc(dir, d2); // pointer 2
    undoFromHistory(dir); // pointer 1 (d1)
    expect(commitDoc(dir, d3)).toBe(2); // overwrites the old 0002 slot
    expect(readPointer(dir)).toBe(2);

    const snap2 = readDoc(path.join(p.historyDir, historyFileName(2)));
    expect(snap2.ok && snap2.doc).toEqual(d3);
    expect(redoFromHistory(dir)).toEqual({ ok: false, errors: ['nothing to redo'] });
    const u = undoFromHistory(dir);
    expect(u.ok && u.doc).toEqual(d1); // history is now base → d1 → d3
  });
});
