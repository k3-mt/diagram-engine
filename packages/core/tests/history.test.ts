// M1 Step 5 — pure history push/undo/redo semantics (document/history.ts).
// pointer = index of the snapshot matching the current document; commits
// after an undo discard the redo tail (the classic branch-cut).

import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  current,
  emptyHistory,
  push,
  redo,
  snapshotName,
  undo,
  type GraphDoc,
} from '../src/index.js';
import { doc } from './helpers.js';

const d0 = doc({ title: 'v0' });
const d1 = doc({ title: 'v1' });
const d2 = doc({ title: 'v2' });
const d3 = doc({ title: 'v3' });

describe('history push/undo/redo', () => {
  it('an empty history has nothing to undo or redo', () => {
    const h = emptyHistory();
    expect(h.pointer).toBe(-1);
    expect(current(h)).toBeUndefined();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h)).toBeNull();
    expect(redo(h)).toBeNull();
  });

  it('a seeded history holds the base state at pointer 0', () => {
    const h = emptyHistory(d0);
    expect(h.pointer).toBe(0);
    expect(current(h)).toEqual(d0);
    expect(canUndo(h)).toBe(false); // the base state itself is not undoable
  });

  it('push advances the pointer; undo/redo walk it', () => {
    let h = emptyHistory(d0);
    h = push(h, d1);
    h = push(h, d2);
    expect(h.pointer).toBe(2);
    expect(current(h)).toEqual(d2);

    const u1 = undo(h);
    expect(u1).not.toBeNull();
    expect(u1!.doc).toEqual(d1);
    const u2 = undo(u1!.history);
    expect(u2!.doc).toEqual(d0);
    expect(canUndo(u2!.history)).toBe(false);
    expect(undo(u2!.history)).toBeNull(); // bottomed out

    const r1 = redo(u2!.history);
    expect(r1!.doc).toEqual(d1);
    const r2 = redo(r1!.history);
    expect(r2!.doc).toEqual(d2);
    expect(redo(r2!.history)).toBeNull(); // topped out
  });

  it('push after undo discards the redo tail', () => {
    let h = emptyHistory(d0);
    h = push(h, d1);
    h = push(h, d2);
    const u = undo(h)!; // back to d1
    const h2 = push(u.history, d3);
    expect(h2.snapshots.map((s: GraphDoc) => s.title)).toEqual(['v0', 'v1', 'v3']);
    expect(h2.pointer).toBe(2);
    expect(canRedo(h2)).toBe(false);
  });

  it('snapshotName zero-pads to four digits', () => {
    expect(snapshotName(0)).toBe('0000');
    expect(snapshotName(42)).toBe('0042');
  });
});
