// document/history.ts — pure undo/redo helpers (spec §2.5, M1 Step 3).
//
// Models the on-disk history directory (an ordered array of snapshots
// 0000.json ... NNNN.json plus a plain-integer pointer file) as a value.
// Everything here is pure — no fs. The store layer owns disk.
//
// `pointer` is the index of the current snapshot in `snapshots`.
// An empty history has pointer -1.

import type { GraphDoc } from '../schema/graph.js';

export interface HistoryState {
  /** Ordered snapshots, oldest first — mirrors history/0000.json ... NNNN.json. */
  snapshots: GraphDoc[];
  /** Index of the current snapshot; -1 when empty. Mirrors history/pointer. */
  pointer: number;
}

/** A fresh history, optionally seeded with an initial snapshot. */
export function emptyHistory(initial?: GraphDoc): HistoryState {
  return initial ? { snapshots: [initial], pointer: 0 } : { snapshots: [], pointer: -1 };
}

/** The current snapshot, or undefined when the history is empty. */
export function current(h: HistoryState): GraphDoc | undefined {
  return h.snapshots[h.pointer];
}

export function canUndo(h: HistoryState): boolean {
  return h.pointer > 0;
}

export function canRedo(h: HistoryState): boolean {
  return h.pointer >= -1 && h.pointer < h.snapshots.length - 1;
}

/**
 * Record a new snapshot after a committed patch. Any redo tail (snapshots
 * past the pointer) is discarded — the classic branch-cut — and the
 * pointer moves to the new snapshot.
 */
export function push(h: HistoryState, doc: GraphDoc): HistoryState {
  const snapshots = [...h.snapshots.slice(0, h.pointer + 1), doc];
  return { snapshots, pointer: snapshots.length - 1 };
}

/**
 * Step the pointer back one snapshot. Returns the new state and the
 * document to restore, or null when there is nothing to undo.
 */
export function undo(h: HistoryState): { history: HistoryState; doc: GraphDoc } | null {
  if (!canUndo(h)) return null;
  const pointer = h.pointer - 1;
  const doc = h.snapshots[pointer];
  if (doc === undefined) return null;
  return { history: { snapshots: h.snapshots, pointer }, doc };
}

/**
 * Step the pointer forward one snapshot. Returns the new state and the
 * document to restore, or null when there is nothing to redo.
 */
export function redo(h: HistoryState): { history: HistoryState; doc: GraphDoc } | null {
  if (!canRedo(h)) return null;
  const pointer = h.pointer + 1;
  const doc = h.snapshots[pointer];
  if (doc === undefined) return null;
  return { history: { snapshots: h.snapshots, pointer }, doc };
}

/** Zero-padded snapshot file stem for index i: 42 -> "0042" (spec §2.5). */
export function snapshotName(index: number): string {
  return String(index).padStart(4, '0');
}
