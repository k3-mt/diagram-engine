// view/viewState.ts — the viewer's LOCAL view selection (spec §7, §1.6, §8.4).
//
// The status bar's [exec] [eng] [focus] buttons need somewhere to keep "which
// audience am I looking at right now". That question collides with two rules,
// so read the resolution before changing anything here.
//
// -------------------------------------------------------------------------
// THE COLLISION, AND HOW IT IS RESOLVED
// -------------------------------------------------------------------------
// `collapsed` is DOCUMENT state: the agent writes it with `diagram view exec`
// through the locked write path, it is undoable, and it is what a teammate
// gets when they open the same graph.json. But §1.6 says the browser must
// never mutate the document, and §7 calls the viewer's buttons "viewport
// controls, not document edits" — the same class of thing as pan and zoom.
//
// So the viewer keeps a LOCAL OVERRIDE, and nothing more:
//
//   * `local === null` means "follow the document" — the drawn view is
//     exactly doc.collapsed, which is the state on first paint.
//   * Clicking a button sets `local` to a computed id list. That list lives
//     in React state in one browser tab. It is never written to disk, never
//     turned into a patch, and never sent back over the socket — the socket
//     is receive-only in this direction and stays that way.
//   * WHEN A NEW DOCUMENT ARRIVES WITH A DIFFERENT doc.collapsed, THE AGENT
//     WINS: `local` resets to null and the picture snaps to what the agent
//     asked for. syncToDoc() is that rule, and it is deliberately keyed on
//     the collapsed SET only — an unrelated patch (a new node, a relabel)
//     leaves a human's chosen view alone, so watching an agent work does not
//     yank you out of the exec view every few seconds.
//
// That keeps model-dictation intact (the document says what the diagram IS,
// including its stored view) while a human can still flick between audiences
// on their own screen without touching the file. The cost is honest and
// small: reload the page, or let the agent run `diagram view`, and the local
// choice is gone. Nothing about it is persisted, so there is no hidden state
// to explain when two people compare screens.
//
// -------------------------------------------------------------------------
// HOW [focus] PICKS A TARGET WITH NO MOUSE SELECTION (§1.6)
// -------------------------------------------------------------------------
// `focus` needs a group id, and there is no click-to-select in this viewer —
// hovering is inspection only. Two options were on the table: cycle, or
// disable. This module does BOTH, in the only split that is honest:
//
//   * With at least one group, [focus] CYCLES through doc.groups in document
//     order, and the button prints the group it is on (`focus: Payments`), so
//     the control always says what it will show rather than hiding a mode.
//     Shift-activate walks backwards; repeated activation wraps.
//   * With no groups at all, [focus] is genuinely inert and is rendered
//     disabled — `resolvePreset` would return `[]`, i.e. exactly the eng
//     view, so an enabled button would be a control that does nothing.
//
// The cycle runs over EVERY group, not just root ones. Restricting it to
// roots would make a nested boundary — the one case where focus earns its
// keep, since exec already shows the roots — unreachable from the browser.
// Document order (not label order) keeps the cycle stable across relabels.
//
// Everything here is pure. React lives in useViewOverride.ts; keeping the
// rules out of the hook is what lets the tests drive them without a DOM.

import type { GGroup, GraphDoc } from '@diagram-engine/core';
import {
  resolvePreset,
  type ViewPresetName,
} from '@diagram-engine/core/src/view/presets.js';
import {
  collapsedAtDepth,
  depthOf,
  maxGroupDepth,
} from '@diagram-engine/core/src/view/depth.js';

/**
 * The viewer's whole view state. Two fields, both nullable, both meaning
 * "nothing chosen here — derive it from the document".
 */
export interface ViewState {
  /**
   * The local collapsed override, or null to follow doc.collapsed. An empty
   * ARRAY is a real choice (the eng view); null is the absence of one.
   */
  local: string[] | null;
  /** The group [focus] is currently pointed at, or null to infer one. */
  focus: string | null;
  /**
   * The containers the reader has picked out to see — "show me only these".
   * `local` still says what is drawn; this remembers WHICH ROWS ARE LIT so
   * membership can be toggled, and so the highlight in the list cannot
   * disagree with the picture.
   *
   * Optional, and absent means none: every state built before this existed
   * stays valid, and `selectedIds` is the one way to read it.
   */
  selected?: string[];
}

/** First paint: follow the document in every respect. */
export const INITIAL_VIEW_STATE: ViewState = { local: null, focus: null, selected: [] };

/** The picked-out containers, never undefined. */
export function selectedIds(state: ViewState): string[] {
  return state.selected ?? [];
}

/**
 * Order-insensitive identity for a collapsed list. Used both to decide
 * whether a preset is active and to decide whether the agent changed the
 * document's view — `["a","b"]` and `["b","a"]` collapse the same groups, so
 * treating them as different would reset a human's view for no reason.
 */
export function collapsedKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('\x00');
}

/** What is actually drawn: the override when there is one, else the document's. */
export function effectiveCollapsed(
  doc: GraphDoc | null,
  state: ViewState,
): string[] {
  if (state.local !== null) return state.local;
  return doc === null ? [] : [...doc.collapsed];
}

/** The groups [focus] cycles through: every group, in document order. */
export function focusCandidates(doc: GraphDoc | null): GGroup[] {
  return doc === null ? [] : [...doc.groups];
}

/** False when [focus] must be rendered disabled (nothing to focus). */
export function canFocus(doc: GraphDoc | null): boolean {
  return focusCandidates(doc).length > 0;
}

/** The collapsed list a preset resolves to, or null when it cannot resolve. */
function collapsedFor(
  doc: GraphDoc,
  name: ViewPresetName,
  id: string | null,
): string[] | null {
  if (name === 'focus') {
    if (id === null) return null;
    const res = resolvePreset(doc, { preset: 'focus', id });
    return res.ok ? res.collapsed : null;
  }
  const res = resolvePreset(doc, { preset: name });
  return res.ok ? res.collapsed : null;
}

/**
 * Which button lights up for a given collapsed list, or null for "none of
 * them" — the agent is entitled to set an arbitrary list with
 * `diagram view --collapsed a b`, and inventing a highlight for it would be
 * a lie about which preset is on screen.
 *
 * Order matters, because presets genuinely overlap on small documents: a doc
 * whose only group is a root one has focus(that group) === [] === eng, and a
 * doc with no groups has all three equal. eng wins, then exec, then focus —
 * least surprising first, since "nothing collapsed" is what the reader sees.
 */
export function activePreset(
  doc: GraphDoc | null,
  collapsed: readonly string[],
  focusId: string | null,
): ViewPresetName | null {
  if (doc === null) return null;
  const key = collapsedKey(collapsed);
  for (const name of ['eng', 'exec', 'focus'] as const) {
    const ids = collapsedFor(doc, name, focusId);
    if (ids !== null && collapsedKey(ids) === key) return name;
  }
  return null;
}

/**
 * The group [focus] would show next time it is pressed with no explicit
 * choice yet: the one the CURRENT collapsed list happens to be a focus view
 * of, else the first group. So arriving on a document the agent left in
 * `focus payments` starts the cycle at payments rather than resetting the
 * user to the top of the list.
 */
export function inferredFocus(
  doc: GraphDoc | null,
  collapsed: readonly string[],
): string | null {
  const groups = focusCandidates(doc);
  if (doc === null || groups.length === 0) return null;
  const key = collapsedKey(collapsed);
  const hit = groups.find((g) => {
    const ids = collapsedFor(doc, 'focus', g.id);
    return ids !== null && collapsedKey(ids) === key;
  });
  return hit?.id ?? groups[0]?.id ?? null;
}

/** The group [focus] is pointed at right now: the explicit choice, or the inferred one. */
export function focusTarget(doc: GraphDoc | null, state: ViewState): string | null {
  if (state.focus !== null && focusCandidates(doc).some((g) => g.id === state.focus)) {
    return state.focus;
  }
  return inferredFocus(doc, effectiveCollapsed(doc, state));
}

/**
 * The next group in the cycle after `current` (`dir: -1` walks backwards).
 * Wraps, and starts at the first group when `current` is unknown — a group
 * the agent deleted must not strand the button.
 */
export function nextFocusTarget(
  doc: GraphDoc | null,
  current: string | null,
  dir: 1 | -1 = 1,
): string | null {
  const groups = focusCandidates(doc);
  if (groups.length === 0) return null;
  const i = groups.findIndex((g) => g.id === current);
  if (i < 0) return groups[0]?.id ?? null;
  const n = groups.length;
  return groups[(i + dir + n) % n]?.id ?? null;
}

/**
 * Press a button. Returns the NEXT state; never mutates the one it is given.
 *
 * [exec] and [eng] are idempotent — pressing the active one repaints the same
 * picture. [focus] is the odd one out: pressing it when focus is already
 * active ADVANCES to the next group, which is what makes a single button a
 * usable selector with no mouse selection available (see the header). The
 * first press only enters focus mode on whatever group is already inferred.
 */
export function selectPreset(
  doc: GraphDoc | null,
  state: ViewState,
  name: ViewPresetName,
  opts: { reverse?: boolean } = {},
): ViewState {
  if (doc === null) return state;

  if (name !== 'focus') {
    const ids = collapsedFor(doc, name, null);
    return ids === null ? state : { local: ids, focus: state.focus, selected: [] };
  }

  if (!canFocus(doc)) return state; // the button is disabled; be safe anyway
  const current = focusTarget(doc, state);
  const already = activePreset(doc, effectiveCollapsed(doc, state), current) === 'focus';
  const target = already
    ? nextFocusTarget(doc, current, opts.reverse === true ? -1 : 1)
    : current;
  const ids = target === null ? null : collapsedFor(doc, 'focus', target);
  return ids === null ? state : { local: ids, focus: target, selected: [] };
}

/**
 * The agent's intent wins: called when a new document arrives, it drops the
 * local override iff the document's collapsed SET changed. `prevKey` is the
 * collapsedKey of the previously seen document (null before the first one).
 *
 * Returning the SAME object when nothing changed matters — the hook uses
 * identity to decide whether to re-render at all.
 */
export function syncToDoc(
  state: ViewState,
  prevKey: string | null,
  nextKey: string,
): ViewState {
  if (prevKey === null || prevKey === nextKey) return state;
  return INITIAL_VIEW_STATE;
}

/**
 * Everything the status bar and the layout pipeline need for one render,
 * derived from the document and the local state. Pure, so the hook that
 * wraps it (useViewOverride.ts) is only memoisation and event plumbing.
 */
export interface ResolvedView {
  /** The collapsed ids to draw with — the ARRAY, never a serialised form. */
  collapsed: string[];
  /** Order-insensitive identity of `collapsed`; a dependency, not a format. */
  key: string;
  /** Which button is lit, or null when the collapsed list matches no preset. */
  active: ViewPresetName | null;
  /** The group [focus] is pointed at, or null when there is nothing to focus. */
  focus: string | null;
  /** That group's label, for the button text. */
  focusLabel: string | null;
  /** False when [focus] must render disabled (the document has no groups). */
  focusEnabled: boolean;
}

/**
 * The whole per-render derivation in one pure call.
 *
 * It exists so that `collapsed` and `key` are produced TOGETHER from the same
 * array, and the array is the thing that travels. An earlier version handed
 * the hook only `key` and reconstructed the array by splitting it, which is a
 * silent trap: the key is a lossy identity (it is sorted and de-duplicated)
 * and any disagreement between the join and the split turns two collapsed
 * groups into one nonexistent id — deriveView then ignores it (its decision
 * 6) and draws the FULL graph while the [exec] button still renders pressed,
 * because the bogus list keys identically. The key is now derived from the
 * array and never parsed back.
 */
export function resolveView(doc: GraphDoc | null, state: ViewState): ResolvedView {
  const collapsed = effectiveCollapsed(doc, state);
  const focus = focusTarget(doc, state);
  return {
    collapsed,
    key: collapsedKey(collapsed),
    active: activePreset(doc, collapsed, focus),
    focus,
    focusLabel: focusCandidates(doc).find((g) => g.id === focus)?.label ?? null,
    focusEnabled: canFocus(doc),
  };
}

// ---------------------------------------------------------------------------
// GRAIN AND PER-CONTAINER CONTROL (the sidebar)
//
// The three presets answer "which audience". They do not answer the two
// questions a reader actually asks while looking at a nested diagram:
//
//   "show me one level less detail"      -> a LEVEL, uniformly applied
//   "open just this one boundary"        -> ONE container, by name
//
// Both are still viewport controls in the §7 sense — they set the same local
// override the buttons do, nothing is written, and a new doc.collapsed from
// the agent still wins. What follows is only the pure logic; the components
// live in render/Sidebar.tsx and its two children.
// ---------------------------------------------------------------------------

/** One selectable level of grain, with what it would collapse. */
export interface DepthOption {
  /** Container level, counted from the outside in: 0 is the top-level groups. */
  depth: number;
  /** The group ids this level collapses. */
  ids: string[];
  /** How many groups that is — what the row shows. */
  count: number;
}

/**
 * Every level worth offering, coarsest first, plus the "everything open" end
 * of the range. A document with no groups offers nothing but that.
 *
 * The list stops at the deepest level that holds a group: offering level 7 on
 * a three-level diagram would be a control that visibly does nothing.
 */
export function depthOptions(doc: GraphDoc | null): DepthOption[] {
  if (doc === null || doc.groups.length === 0) return [];
  const deepest = maxGroupDepth(doc);
  const out: DepthOption[] = [];
  for (let depth = 0; depth <= deepest; depth += 1) {
    const ids = collapsedAtDepth(doc, depth);
    out.push({ depth, ids, count: ids.length });
  }
  return out;
}

/**
 * Which level the current picture is at, or null when the collapsed set is
 * not a level at all — which is the honest answer after someone has opened
 * one container by hand. Highlighting a level then would claim a uniformity
 * the picture does not have.
 */
export function activeDepth(
  doc: GraphDoc | null,
  collapsed: readonly string[],
): number | null {
  if (doc === null) return null;
  const key = collapsedKey(collapsed);
  for (const option of depthOptions(doc)) {
    if (collapsedKey(option.ids) === key) return option.depth;
  }
  return null;
}

/** Set the grain to one uniform level. */
export function selectDepth(
  doc: GraphDoc | null,
  state: ViewState,
  depth: number,
): ViewState {
  if (doc === null) return state;
  // A level is a different way of deciding what is open, so it ends the
  // "only these" selection rather than leaving a highlight that no longer
  // describes the picture.
  return { local: collapsedAtDepth(doc, depth), focus: state.focus, selected: [] };
}

/**
 * Open or shut ONE container, leaving every other decision alone.
 *
 * This is the control the viewer never had: with only presets, seeing inside
 * one boundary meant `focus`, which shuts every OTHER boundary as a side
 * effect. Here the rest of the picture holds still.
 */
export function toggleGroup(
  doc: GraphDoc | null,
  state: ViewState,
  id: string,
): ViewState {
  if (doc === null || !doc.groups.some((g) => g.id === id)) return state;
  const current = effectiveCollapsed(doc, state);
  const next = current.includes(id)
    ? current.filter((c) => c !== id)
    : [...current, id];
  return { local: next, focus: state.focus, selected: [] };
}

/**
 * The containers enclosing `id`, nearest first. A parent cycle terminates on
 * the seen set rather than spinning (V4 rejects one, but this never assumes
 * validation ran).
 */
export function ancestorIds(doc: GraphDoc, id: string): string[] {
  const parentOf = new Map<string, string | null>();
  for (const g of doc.groups) parentOf.set(g.id, g.parent);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = parentOf.get(id) ?? null;
  while (cur !== null && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return out;
}

/**
 * GO TO a container: open it, and open everything hiding it.
 *
 * The difference from toggleGroup is the ancestors. A row three levels down
 * may be perfectly "open" and still not on screen because a boundary above it
 * is shut — opening only itself would leave the reader clicking a row that
 * visibly does nothing, which is exactly the dead end this replaces. So the
 * whole chain from the outermost boundary down to the target comes open, and
 * every OTHER container keeps the state the reader gave it.
 *
 * Deliberately not `focus`: focus shuts every unrelated boundary to isolate
 * one. This only opens; nothing else in the picture closes.
 */
export function revealGroup(
  doc: GraphDoc | null,
  state: ViewState,
  id: string,
): ViewState {
  if (doc === null || !doc.groups.some((g) => g.id === id)) return state;
  const open = new Set<string>([id, ...ancestorIds(doc, id)]);
  const next = effectiveCollapsed(doc, state).filter((c) => !open.has(c));
  return { local: next, focus: state.focus, selected: [] };
}

/**
 * "Show me only these": the collapsed list that leaves `ids` open and shuts
 * every other container.
 *
 * Ancestors of a selected container stay open too — they have to, or the
 * selected one is inside a shut box and the whole point is lost. Everything
 * else collapses, INCLUDING the descendants of a selection, so picking a
 * container shows what is directly in it rather than exploding three levels
 * of nesting onto the screen. Pick the child as well when you want that.
 *
 * An empty selection collapses nothing: with nothing picked out, "only these"
 * has no meaning, and shutting everything would be a strange way to say it.
 */
export function isolateCollapsed(
  doc: GraphDoc | null,
  ids: readonly string[],
): string[] {
  if (doc === null || ids.length === 0) return [];
  const open = new Set<string>();
  for (const id of ids) {
    open.add(id);
    for (const a of ancestorIds(doc, id)) open.add(a);
  }
  return doc.groups.filter((g) => !open.has(g.id)).map((g) => g.id);
}

/**
 * Add or remove one container from the selection, and redraw as "only these".
 *
 * Clearing the last one shows EVERYTHING rather than nothing. The alternative
 * — falling back to whatever was on screen before the selection started —
 * means the same gesture (unpick the last row) lands somewhere different
 * depending on history, which is the kind of control people stop trusting.
 */
export function toggleSelected(
  doc: GraphDoc | null,
  state: ViewState,
  id: string,
): ViewState {
  if (doc === null || !doc.groups.some((g) => g.id === id)) return state;
  const current = selectedIds(state);
  const next = current.includes(id)
    ? current.filter((c) => c !== id)
    : [...current, id];
  return { local: isolateCollapsed(doc, next), focus: state.focus, selected: next };
}

/** Drop the selection and open everything. */
export function clearSelection(state: ViewState): ViewState {
  return { local: [], focus: state.focus, selected: [] };
}

/** One row of the container tree the sidebar draws. */
export interface ContainerRow {
  group: GGroup;
  /** Container level, for the row's indent and its level badge. */
  depth: number;
  /** True when this group is itself collapsed. */
  collapsed: boolean;
  /**
   * True when an ANCESTOR is collapsed, so this row is not on screen at all
   * whatever its own state. The row stays listed and says so, because
   * hiding it would leave the reader hunting for a group the diagram no
   * longer shows.
   */
  hiddenByAncestor: boolean;
  /**
   * The NEAREST collapsed container above this one, or null when nothing is
   * hiding it. Carried as a label rather than just a flag so the row can name
   * the thing to open — "inside Landing zone, which is collapsed" is a hint
   * someone can act on; a grey row is not.
   */
  hiddenBy: { id: string; label: string } | null;
  /** Nodes directly inside, for the "what is in here" count. */
  nodeCount: number;
  /** Groups directly inside. */
  groupCount: number;
  /** True when this container is one of the picked-out set. */
  selected: boolean;
}

/**
 * The container tree in document order, with each row's depth, state and
 * contents. Document order rather than sorted: it matches `focus`'s cycle and
 * stays stable when a group is relabelled.
 */
export function containerRows(
  doc: GraphDoc | null,
  collapsed: readonly string[],
  selected: readonly string[] = [],
): ContainerRow[] {
  if (doc === null) return [];
  const picked = new Set(selected);
  const shut = new Set(collapsed);
  const labelOf = new Map(doc.groups.map((g) => [g.id, g.label]));
  // Nearest first, so the name offered is the one boundary that actually has
  // to open next — not the outermost one, which may be several steps away.
  const hiderOf = (id: string): { id: string; label: string } | null => {
    const hit = ancestorIds(doc, id).find((a) => shut.has(a));
    return hit === undefined ? null : { id: hit, label: labelOf.get(hit) ?? hit };
  };

  return doc.groups.map((group) => {
    const hiddenBy = hiderOf(group.id);
    return {
    group,
    depth: depthOf(doc, group.id),
    collapsed: shut.has(group.id),
    hiddenByAncestor: hiddenBy !== null,
    hiddenBy,
    nodeCount: doc.nodes.filter((n) => n.parent === group.id).length,
    groupCount: doc.groups.filter((g) => g.parent === group.id).length,
    selected: picked.has(group.id),
    };
  });
}

// ---------------------------------------------------------------------------
// SAYING WHAT A ROW MEANS
//
// Three visual states were carrying meaning that only the author knew: dimmed,
// tinted grey, and blue-barred. Colour alone is a poor way to say "this is not
// on screen because something else is shut" — it is unreadable to anyone who
// cannot separate the tones, and unguessable to everyone else. So every row
// states its condition in words on hover, and the words name the container to
// act on rather than describing the shade.
// ---------------------------------------------------------------------------

/** The short chip at the end of the row: its state, or what is inside it. */
export function rowStateText(row: ContainerRow): string {
  if (row.hiddenByAncestor) return 'not shown';
  if (row.collapsed) return 'collapsed';
  const parts: string[] = [];
  if (row.nodeCount > 0) {
    parts.push(`${row.nodeCount} node${row.nodeCount === 1 ? '' : 's'}`);
  }
  if (row.groupCount > 0) {
    parts.push(`${row.groupCount} container${row.groupCount === 1 ? '' : 's'}`);
  }
  return parts.length === 0 ? 'empty' : parts.join(' · ');
}

/**
 * The full sentence on hover: what this row's appearance means, and what
 * pressing it will do. Ordered by what the reader is most likely confused
 * about — being hidden beats being collapsed, which beats being ticked.
 */
export function rowHint(row: ContainerRow): string {
  const name = row.group.label;
  if (row.hiddenBy !== null) {
    return (
      `“${name}” is not on the diagram right now: “${row.hiddenBy.label}” is ` +
      'collapsed around it. Click this name to go there — every container ' +
      'above it opens, and nothing else closes.'
    );
  }
  if (row.collapsed) {
    return (
      `“${name}” is drawn as a single box; what is inside it is hidden. ` +
      'Click the chevron to open it in place.'
    );
  }
  if (row.selected) {
    return (
      `“${name}” is one of the ticked containers, so it is open while every ` +
      'unticked container is collapsed. Untick it to drop it from the set.'
    );
  }
  return `“${name}” is open, showing ${rowStateText(row)}. The chevron collapses it.`;
}

/**
 * The one-line readout the status strip carries: what the picture is showing
 * right now, in the same words the sidebar uses.
 *
 *   "all containers open"
 *   "level 1 · 5 of 8 containers collapsed"
 *   "4 of 8 containers collapsed"      (a hand-picked set, no level)
 *
 * It lives here rather than in the bar because it is a statement about the
 * VIEW, and the bar is deliberately dumb about views.
 */
export function viewSummaryText(
  doc: GraphDoc | null,
  collapsed: readonly string[],
): string {
  const total = doc?.groups.length ?? 0;
  if (total === 0) return 'no containers';
  const shut = new Set(collapsed).size;
  if (shut === 0) return 'all containers open';
  const depth = activeDepth(doc, collapsed);
  const level = depth === null ? '' : `level ${depth} · `;
  return `${level}${shut} of ${total} containers collapsed`;
}
