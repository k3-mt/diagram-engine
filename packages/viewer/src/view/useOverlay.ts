// view/useOverlay.ts — the React binding for the analysis overlays
// (spec §15.5, §18.7). All the rules live in overlayState.ts; this file is the
// wiring, so the rules stay testable without a DOM — the same split
// useViewOverride.ts / viewState.ts already use.
//
// It owns three things a pure function cannot:
//
//  1. THE COST. `analyse` and `blastRadius` are cheap (sub-millisecond at the
//     200-element cap) and the experiment BACKLOG is now cheap too — it sweeps
//     the articulation points ONCE and hands the map to every candidate rather
//     than rebuilding it per row, which is the difference between ~35ms and
//     ~2s at the cap. It is still the largest single piece of work the viewer
//     does, and it would otherwise run on every document a working agent
//     pushes while the overlay is switched off and nobody has asked for it.
//
//     So the backlog is ARMED: it is not computed until the user first presses
//     an overlay button in this tab, after which it is memoised per document.
//     Before that, [blast] is enabled because there is something drawn, which
//     is the honest reason to offer the control. If the first press turns out
//     to find no candidates — every drawn element is an entry point, or the
//     document is a pure ERD — `selectOverlay` leaves the mode off and the
//     button then renders disabled, having told the truth as soon as it knew
//     it. Nothing is cached across documents, so a patch is always reflected.
//
//  2. THE MEMOISATION KEYS. `analysis` and `blast` are recomputed only when
//     the document, the mode or the target changes — never on a hover, a pan,
//     or the status bar's "Xs ago" tick. `analyse` is not called at all while
//     the mode is `blast`, and vice versa: the two overlays are exclusive, so
//     computing both would double the work to draw one.
//
//  3. NOTHING ELSE. In particular there is no effect that writes anywhere.
//     Both overlays are reads (A1) and viewport controls (§7, §1.6): no patch,
//     no socket send, no file. See overlayState.ts for the full argument.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { GraphDoc } from '@diagram-engine/core';
// Runtime imports of the core SOURCE modules, not the barrel (which pulls in
// store/ and with it node:fs). Same route the rest of the viewer takes.
import {
  analyse,
  blastRadius,
  type Analysis,
  type BacklogEntry,
  type BlastRadius,
} from '../../../core/src/analysis/index.js';
import {
  INITIAL_OVERLAY_STATE,
  blastCandidates,
  resolveOverlayFrom,
  selectOverlay,
  type DrawnIndex,
  type OverlayButtonName,
  type OverlayState,
  type ResolvedOverlay,
} from './overlayState.js';

/** What the status-bar buttons and the overlay renderer need. */
export interface Overlay extends ResolvedOverlay {
  /** §15's answer over the FULL document (A2), or null unless the mode is on. */
  analysis: Analysis | null;
  /** §18.3's prediction for the current target, or null unless the mode is on. */
  blast: BlastRadius | null;
  /** Press a button. Local only — never writes to the document (§1.6). */
  select: (name: OverlayButtonName, opts?: { reverse?: boolean }) => void;
}

export function useOverlay(doc: GraphDoc | null, idx: DrawnIndex): Overlay {
  const [state, setState] = useState<OverlayState>(INITIAL_OVERLAY_STATE);
  // Rule 1: has anyone in this tab asked for an overlay yet?
  const [armed, setArmed] = useState(false);

  const candidates = useMemo<BacklogEntry[]>(
    () => (armed ? blastCandidates(doc, idx) : []),
    [armed, doc, idx],
  );

  const resolved = resolveOverlayFrom(candidates, state);
  const { mode, target } = resolved;

  // Rule 2. Both take the FULL document — never `derived` (A2): running the
  // analysis on the collapsed picture is exactly how `exec` would hide the
  // chokepoints the overlay exists to show.
  const analysis = useMemo(
    () => (doc === null || mode !== 'analysis' ? null : analyse(doc)),
    [doc, mode],
  );
  const blast = useMemo(
    () =>
      doc === null || mode !== 'blast' || target === null
        ? null
        : blastRadius(doc, target),
    [doc, mode, target],
  );

  // The press handler must see the backlog for the document it is pressed on,
  // and on the very first press the memo above has not run yet (nothing was
  // armed). So the handler computes it itself from refs holding this render's
  // inputs, and arming makes every later render use the memo.
  const docRef = useRef(doc);
  docRef.current = doc;
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  const select = useCallback(
    (name: OverlayButtonName, opts?: { reverse?: boolean }) => {
      const list = armedRef.current
        ? candidatesRef.current
        : blastCandidates(docRef.current, idxRef.current);
      if (!armedRef.current) setArmed(true);
      setState((s) => selectOverlay(s, name, list, opts ?? {}));
    },
    [],
  );

  return {
    ...resolved,
    // Before the first press there is no backlog, so `resolved.blastEnabled`
    // would be false and the button would be disabled — and a disabled button
    // can never be pressed, which is the one way arming could deadlock. Until
    // armed, the honest and cheap answer is "there is something drawn, so the
    // question can be asked"; the first press computes the real list and the
    // button tells the truth from then on.
    blastEnabled: armed ? resolved.blastEnabled : idx.ids.size > 0,
    analysis,
    blast,
    select,
  };
}
