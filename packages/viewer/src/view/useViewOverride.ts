// view/useViewOverride.ts — the React binding for the local view override
// (spec §7, §8.4). All the rules live in viewState.ts; this file is only the
// wiring, so the rules stay testable without a DOM.
//
// Two things it owns that a pure function cannot:
//
//  1. THE RESET. `syncToDoc` needs the PREVIOUS document's collapsed key, so
//     the hook remembers it and applies the rule during render (the standard
//     "derive state from props" pattern — cheaper and flicker-free compared
//     with an effect, which would paint one frame of the stale view before
//     snapping to the agent's). The previous key is held in STATE, not in a
//     ref: React 18 may start a render and throw it away, and a ref written
//     during a discarded render survives, which would make the redone render
//     see prev === next and skip the agent's reset. State participates in
//     that rollback; a ref does not.
//  2. A STABLE `collapsed` ARRAY. main.tsx feeds it into a useMemo that runs
//     deriveView and then into the layout request; a fresh array identity on
//     every render would re-lay-out the graph on every mouse move. That one
//     array is memoised on the order-insensitive collapsedKey, so its identity
//     changes only when the collapsed SET does — and it is carried through AS
//     an array. It is never rebuilt by parsing the key: see resolveView's note
//     for the bug that idiom caused.

import { useCallback, useMemo, useState } from 'react';
import type { GraphDoc } from '@diagram-engine/core';
import type { ViewPresetName } from '../../../core/src/view/presets.js';
import {
  INITIAL_VIEW_STATE,
  collapsedKey,
  resolveView,
  selectPreset,
  syncToDoc,
  type ResolvedView,
  type ViewState,
} from './viewState.js';

/** What the status-bar buttons and the layout pipeline need. */
export interface ViewOverride extends ResolvedView {
  /** Press a button. Local only — never writes to the document (§1.6). */
  select: (name: ViewPresetName, opts?: { reverse?: boolean }) => void;
}

export function useViewOverride(doc: GraphDoc | null): ViewOverride {
  const [state, setState] = useState<ViewState>(INITIAL_VIEW_STATE);
  const [prevDocKey, setPrevDocKey] = useState<string | null>(null);

  // Rule 1: a new document whose collapsed SET differs is the agent stating
  // its intent, and it outranks whatever this browser tab picked.
  const docKey = doc === null ? null : collapsedKey(doc.collapsed);
  let current = state;
  if (docKey !== null && docKey !== prevDocKey) {
    const synced = syncToDoc(state, prevDocKey, docKey);
    setPrevDocKey(docKey); // render-phase update: React re-renders before painting
    if (synced !== state) {
      current = synced;
      setState(synced);
    }
  }

  // Rule 2: one pure derivation per render, of which exactly ONE field needs
  // a stable identity — the array that feeds deriveView and the layout
  // request. It is memoised on the order-insensitive key (deliberately the
  // only dependency: a relabel must not re-lay-out the graph), while `active`,
  // `focus` and `focusLabel` are recomputed every render so a renamed group
  // updates its button text immediately. The memo lives in the fiber, so a
  // render React starts and throws away takes it with it.
  const resolved = resolveView(doc, current);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  const collapsed = useMemo(() => resolved.collapsed, [resolved.key]);

  const select = useCallback(
    (name: ViewPresetName, opts?: { reverse?: boolean }) => {
      setState((s) => selectPreset(doc, s, name, opts ?? {}));
    },
    [doc],
  );

  return { ...resolved, collapsed, select };
}
