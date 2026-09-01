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
  activeDepth,
  collapsedKey,
  containerRows,
  depthOptions,
  focusCandidates,
  focusGroup,
  revealGroup,
  clearSelection,
  selectedIds,
  toggleSelected,
  resolveView,
  selectDepth,
  selectPreset,
  syncToDoc,
  toggleGroup,
  viewSummaryText,
  type ContainerRow,
  type DepthOption,
  type ResolvedView,
  type ViewState,
} from './viewState.js';

/** What the status-bar buttons, the sidebar and the layout pipeline need. */
export interface ViewOverride extends ResolvedView {
  /** Press a button. Local only — never writes to the document (§1.6). */
  select: (name: ViewPresetName, opts?: { reverse?: boolean }) => void;
  /** Every group the focus picker can offer, in document order. */
  focusOptions: { id: string; label: string }[];
  /** Focus one named group, or null to leave focus (see focusGroup). */
  selectFocus: (id: string | null) => void;
  /** The levels of grain on offer, coarsest first (sidebar, Grain section). */
  depths: DepthOption[];
  /** The level the picture is at, or null when it is not a uniform level. */
  depth: number | null;
  /** Set the grain to one uniform level. */
  selectDepth: (depth: number) => void;
  /** One row per container, with its level, state and contents. */
  containers: ContainerRow[];
  /** Open or shut ONE container, leaving the rest of the picture alone. */
  toggleContainer: (id: string) => void;
  /** Go to a container: open it and every boundary hiding it. */
  revealContainer: (id: string) => void;
  /** Add or remove a container from the "show only these" selection. */
  selectContainer: (id: string) => void;
  /** How many containers are picked out; 0 means no selection is active. */
  selectedCount: number;
  /** Drop the selection and open everything. */
  clearSelection: () => void;
  /** True while the picture is the document's own view, not a local choice. */
  followingDocument: boolean;
  /** The status strip's one-line readout of all of the above. */
  summary: string;
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

  // The focus PICKER's action: one named group, or null to leave focus. It
  // does not cycle — the dropdown names its target, so there is nothing to
  // step through.
  const onSelectFocus = useCallback(
    (id: string | null) => setState((s) => focusGroup(doc, s, id)),
    [doc],
  );

  const onSelectDepth = useCallback(
    (depth: number) => setState((s) => selectDepth(doc, s, depth)),
    [doc],
  );

  const toggleContainer = useCallback(
    (id: string) => setState((s) => toggleGroup(doc, s, id)),
    [doc],
  );

  const revealContainer = useCallback(
    (id: string) => setState((s) => revealGroup(doc, s, id)),
    [doc],
  );

  const selectContainer = useCallback(
    (id: string) => setState((s) => toggleSelected(doc, s, id)),
    [doc],
  );

  const onClearSelection = useCallback(() => setState((s) => clearSelection(s)), []);

  // The sidebar's three sections, derived fresh each render like `active` and
  // `focusLabel` above: they are small lists over doc.groups, and a stale one
  // would show a renamed container under its old name. Only `collapsed` needs
  // a stable identity, and only because the layout pipeline keys off it.
  const depths = depthOptions(doc);
  const picked = selectedIds(current);
  const containers = containerRows(doc, resolved.collapsed, picked);

  return {
    ...resolved,
    collapsed,
    select,
    // Every group, in document order, for the focus dropdown. Derived fresh
    // each render like `active` and `focusLabel`, so a renamed or deleted
    // container is right in the list immediately.
    focusOptions: focusCandidates(doc).map((g) => ({ id: g.id, label: g.label })),
    selectFocus: onSelectFocus,
    depths,
    depth: activeDepth(doc, resolved.collapsed),
    selectDepth: onSelectDepth,
    containers,
    toggleContainer,
    revealContainer,
    selectContainer,
    selectedCount: picked.length,
    clearSelection: onClearSelection,
    followingDocument: current.local === null,
    summary: viewSummaryText(doc, resolved.collapsed),
  };
}
