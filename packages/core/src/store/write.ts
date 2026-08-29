// store/write.ts — atomic writes, locking, and on-disk history (spec §2.5).
//
// Atomic writes: always write graph.json.tmp then fs.renameSync. The viewer
// watches graph.json; a partial read renders a broken diagram, and a chokidar
// event on a half-written file throws a JSON parse error into the reconnect
// loop.
//
// Concurrency: assume one writer. Take an exclusive .diagram/.lock
// (fs.openSync with "wx") for the read-modify-write cycle, with a 2s stale
// timeout takeover. Two agent turns racing on the same base document is the
// realistic failure, and it silently loses a patch without this.
//
// History: history/NNNN.json snapshots (zero-padded) plus a plain-integer
// pointer file. The pointer is the index of the snapshot that matches the
// current graph.json. Committing past the pointer discards the redo tail.
//
// NOTE: src/document/history.ts did not exist when this module was written
// (another agent builds document/ concurrently), so the disk-side history is
// implemented directly here rather than wired to pure helpers.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphDoc } from '../schema/graph.js';
import { diagramPaths } from './paths.js';
import { emptyDoc, parseDoc, readDoc, type ReadDocResult } from './read.js';

/** A lock older than this is considered abandoned and is taken over. */
export const LOCK_STALE_MS = 2000;

/** How long acquireLock waits for a live lock before giving up. */
export const LOCK_WAIT_MS = 2000;

const LOCK_POLL_MS = 25;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function serialise(doc: GraphDoc): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Synchronous sleep — the lock poll runs inside a sync fs cycle. */
function sleepSync(ms: number): void {
  try {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* busy wait fallback */
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Atomically write graph.json for the given .diagram/ directory:
 * write graph.json.tmp, then fs.renameSync over graph.json (spec §2.5).
 */
export function writeDocAtomic(dir: string, doc: GraphDoc): void {
  const p = diagramPaths(dir);
  ensureDir(p.dir);
  fs.writeFileSync(p.graphTmpFile, serialise(doc), 'utf8');
  fs.renameSync(p.graphTmpFile, p.graphFile);
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

/**
 * Acquire the exclusive lock file via fs.openSync with "wx" (fails if the
 * file already exists). A lock whose mtime is older than `staleMs`
 * (default 2s) is treated as abandoned and taken over. A live lock is
 * polled until `waitMs` elapses, then an error is thrown.
 */
export function acquireLock(
  lockFile: string,
  opts: { staleMs?: number; waitMs?: number } = {},
): void {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      );
      fs.closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    // The lock exists. Stale takeover?
    let stale = false;
    try {
      const st = fs.statSync(lockFile);
      stale = Date.now() - st.mtimeMs > staleMs;
    } catch {
      stale = false; // vanished between open and stat — just retry the open
    }
    if (stale) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `could not acquire ${lockFile}: held by another process (waited ${waitMs}ms)`,
      );
    }
    sleepSync(LOCK_POLL_MS);
  }
}

/** Release the lock file. Safe to call when the file is already gone. */
export function releaseLock(lockFile: string): void {
  fs.rmSync(lockFile, { force: true });
}

/**
 * Run `fn` while holding the exclusive .lock for the given .diagram/
 * directory — the wrapper for every read-modify-write cycle. The lock is
 * always released, including when `fn` throws.
 */
export function withLock<T>(dir: string, fn: () => T): T {
  const p = diagramPaths(dir);
  ensureDir(p.dir);
  acquireLock(p.lockFile);
  try {
    return fn();
  } finally {
    releaseLock(p.lockFile);
  }
}

// ---------------------------------------------------------------------------
// History: history/NNNN.json + pointer
// ---------------------------------------------------------------------------

/** Zero-padded snapshot file name: 0 → "0000.json", 42 → "0042.json". */
export function historyFileName(index: number): string {
  return `${String(index).padStart(4, '0')}.json`;
}

/**
 * Read history/pointer (a plain integer). Returns -1 when the pointer file
 * does not exist or is unreadable — i.e. no history yet.
 */
export function readPointer(dir: string): number {
  const p = diagramPaths(dir);
  let raw: string;
  try {
    raw = fs.readFileSync(p.pointerFile, 'utf8');
  } catch {
    return -1;
  }
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/** Write history/pointer as a plain integer. */
export function writePointer(dir: string, index: number): void {
  const p = diagramPaths(dir);
  ensureDir(p.historyDir);
  fs.writeFileSync(p.pointerFile, `${index}\n`, 'utf8');
}

/** Read and validate one history snapshot. Missing snapshot is an error. */
export function readSnapshot(dir: string, index: number): ReadDocResult {
  const p = diagramPaths(dir);
  const file = path.join(p.historyDir, historyFileName(index));
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, errors: [`no history snapshot ${historyFileName(index)}`] };
  }
  const result = parseDoc(raw);
  if (!result.ok) {
    return { ok: false, errors: result.errors.map((msg) => `${file}: ${msg}`) };
  }
  return result;
}

/**
 * Record `doc` as the next history snapshot and advance the pointer.
 *
 * - On the very first snapshot, the current on-disk graph.json (or the
 *   empty document if there is none) is seeded as snapshot 0000 first, so
 *   the first patch can be undone.
 * - Any snapshots beyond the current pointer (the redo tail left by undo)
 *   are discarded.
 *
 * Returns the new pointer index. Call this BEFORE writeDocAtomic so the
 * seeded base state is the pre-patch document. Caller holds the lock.
 */
export function snapshotHistory(dir: string, doc: GraphDoc): number {
  const p = diagramPaths(dir);
  ensureDir(p.historyDir);

  let pointer = readPointer(dir);
  if (pointer < 0) {
    // Seed the base state (pre-patch graph.json, or the empty document).
    const base = readDoc(p.graphFile);
    const baseDoc = base.ok ? base.doc : emptyDoc();
    fs.writeFileSync(
      path.join(p.historyDir, historyFileName(0)),
      serialise(baseDoc),
      'utf8',
    );
    pointer = 0;
  }

  // Discard the redo tail: snapshots with an index beyond the pointer.
  for (const entry of fs.readdirSync(p.historyDir)) {
    const match = /^(\d{4,})\.json$/.exec(entry);
    if (match !== null && Number.parseInt(match[1]!, 10) > pointer) {
      fs.rmSync(path.join(p.historyDir, entry), { force: true });
    }
  }

  const next = pointer + 1;
  fs.writeFileSync(
    path.join(p.historyDir, historyFileName(next)),
    serialise(doc),
    'utf8',
  );
  writePointer(dir, next);
  return next;
}

/**
 * Commit a new document state: under the lock, snapshot it into history
 * (seeding the base state on the first commit) and atomically write
 * graph.json. Returns the new history pointer index.
 *
 * The caller is expected to have already run applyPatch/validate — the
 * store persists documents, it does not judge them.
 */
export function commitDoc(dir: string, doc: GraphDoc): number {
  return withLock(dir, () => {
    const index = snapshotHistory(dir, doc); // reads pre-patch graph.json for the seed
    writeDocAtomic(dir, doc);
    return index;
  });
}

/**
 * Undo: move the pointer back one snapshot and make that snapshot the
 * current graph.json. Runs its own lock cycle.
 */
export function undoFromHistory(dir: string): ReadDocResult {
  return withLock(dir, () => {
    const pointer = readPointer(dir);
    if (pointer <= 0) {
      return { ok: false, errors: ['nothing to undo'] } as const;
    }
    const prev = readSnapshot(dir, pointer - 1);
    if (!prev.ok) return prev;
    writeDocAtomic(dir, prev.doc);
    writePointer(dir, pointer - 1);
    return prev;
  });
}

/**
 * Redo: move the pointer forward one snapshot and make that snapshot the
 * current graph.json. Runs its own lock cycle.
 */
export function redoFromHistory(dir: string): ReadDocResult {
  return withLock(dir, () => {
    const pointer = readPointer(dir);
    if (pointer < 0) {
      return { ok: false, errors: ['nothing to redo'] } as const;
    }
    const next = readSnapshot(dir, pointer + 1);
    if (!next.ok) {
      return { ok: false, errors: ['nothing to redo'] } as const;
    }
    writeDocAtomic(dir, next.doc);
    writePointer(dir, pointer + 1);
    return next;
  });
}
