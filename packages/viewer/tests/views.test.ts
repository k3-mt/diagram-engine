// tests/views.test.ts — M7 views in the VIEWER (spec §7, §8.4).
//
// Three things are under test, in the order the pipeline hits them:
//
//  1. deriveView is applied BEFORE layout, so collapsing actually changes the
//     picture: the laid-out node set becomes the collapsed one, the hidden
//     insides are gone, and the stand-in node is still resolvable by id (the
//     hover panel looks ids up against the drawn document).
//  2. the local override rules from view/viewState.ts — which button is lit,
//     what [focus] does on a second press, and the one that matters most:
//     the agent's doc.collapsed reclaims the view, while an unrelated patch
//     leaves a human's chosen view alone.
//  3. the buttons themselves render into StatusBar's `views` slot, report
//     their state through aria-pressed, and disable [focus] when there is
//     nothing to focus.
//
// Rendered with react-dom/server like tests/render.test.ts: no DOM needed,
// and no click simulation — the press logic is a pure function (selectPreset)
// and is driven directly.

import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GNode, GraphDoc } from '@diagram-engine/core';
import {
  collapsedGroupKind,
  deriveView,
  isCollapsedGroupNode,
} from '../../core/src/view/derive.js';
import { layout } from '../src/layout/runLayout.js';
import { kindText, visibleMeta } from '../src/render/HoverCard.js';
import { CollapsedGroupIcon, NODE_ICONS } from '../src/render/icons.js';
import { NodeContent, nodeIcon } from '../src/render/NodeBox.js';
import { StatusBar } from '../src/render/StatusBar.js';
import {
  ViewButtons,
  NO_FOCUS,
  focusOptionText,
  sortFocusOptions,
} from '../src/render/ViewButtons.js';
import {
  INITIAL_VIEW_STATE,
  activePreset,
  canFocus,
  collapsedKey,
  effectiveCollapsed,
  focusCandidates,
  focusGroup,
  focusTarget,
  inferredFocus,
  nextFocusTarget,
  resolveView,
  selectPreset,
  syncToDoc,
  type ViewState,
} from '../src/view/viewState.js';

// --- fixture ---------------------------------------------------------------
// Two root boundaries, one nested group, one node outside everything, and
// three edges — two of which merge when `platform` and `data` both collapse.

const doc: GraphDoc = {
  schemaVersion: 1,
  title: 'Views fixture',
  direction: 'DOWN',
  groups: [
    { id: 'platform', label: 'Platform', kind: 'vpc', parent: null },
    { id: 'payments', label: 'Payments', kind: 'cluster', parent: 'platform' },
    { id: 'data', label: 'Data', kind: 'vpc', parent: null },
  ],
  nodes: [
    { id: 'api', label: 'API', type: 'service', parent: 'payments' },
    { id: 'worker', label: 'Worker', type: 'service', parent: 'payments' },
    { id: 'db', label: 'Postgres', type: 'database', parent: 'data' },
    { id: 'cdn', label: 'CDN', type: 'external', parent: null },
  ],
  edges: [
    { id: 'e1', from: 'cdn', to: 'api', label: 'serves' },
    { id: 'e2', from: 'api', to: 'db', label: 'reads' },
    { id: 'e3', from: 'worker', to: 'db', label: 'reads' },
  ],
  collapsed: [],
};

/** doc with a different stored view — what a `diagram view exec` produces. */
const docExec: GraphDoc = { ...doc, collapsed: ['platform', 'data'] };

const withState = (local: string[] | null, focus: string | null): ViewState => ({
  local,
  focus,
});

// --- 1. derive-then-layout -------------------------------------------------

describe('deriveView is applied before layout (§7)', () => {
  it('lays out the collapsed node set, not the stored one', async () => {
    const derived = deriveView(doc, ['platform', 'data']);
    const laid = await layout(derived);
    const ids = [...laid.nodes.keys()].sort();

    // The two boundaries are now boxes; their insides are gone entirely.
    expect(ids).toEqual(['cdn', 'data', 'platform']);
    for (const hidden of ['api', 'worker', 'db', 'payments']) {
      expect(laid.nodes.has(hidden)).toBe(false);
    }
  });

  it('leaves the eng view identical to the document', async () => {
    const derived = deriveView(doc, []);
    const laid = await layout(derived);
    expect([...laid.nodes.keys()].sort()).toEqual(
      [...doc.nodes.map((n) => n.id), ...doc.groups.map((g) => g.id)].sort(),
    );
    expect(laid.edges.length).toBe(doc.edges.length);
  });

  it('merges the two edges that now run between the same pair of boxes', async () => {
    const derived = deriveView(doc, ['platform', 'data']);
    // cdn -> platform survives; api->db and worker->db merge into one.
    expect(derived.edges.length).toBe(2);
    const merged = derived.edges.find((e) => e.from === 'platform');
    expect(merged?.to).toBe('data');
    expect(merged?.label).toBe('reads ×2');
    const laid = await layout(derived);
    expect(laid.edges.length).toBe(2);
  });

  it('keeps a collapsed group resolvable by id, so the hover panel still works', () => {
    const derived = deriveView(doc, ['platform']);
    // main.tsx resolves the hovered id with frame.doc.nodes.find(...).
    const hovered = derived.nodes.find((n) => n.id === 'platform');
    expect(hovered).toBeDefined();
    expect(isCollapsedGroupNode(hovered!)).toBe(true);
    expect(hovered!.label).toBe('Platform');
    expect(hovered!.note).toBe('2 components');
  });
});

// --- 2. the local override -------------------------------------------------

describe('collapsedKey and effectiveCollapsed', () => {
  it('is order-insensitive and deduped', () => {
    expect(collapsedKey(['b', 'a', 'b'])).toBe(collapsedKey(['a', 'b']));
  });

  it('follows the document until a button is pressed', () => {
    expect(effectiveCollapsed(docExec, INITIAL_VIEW_STATE)).toEqual([
      'platform',
      'data',
    ]);
    expect(effectiveCollapsed(docExec, withState([], null))).toEqual([]);
  });
});

describe('activePreset — which button is lit', () => {
  it('reports eng for nothing collapsed', () => {
    expect(activePreset(doc, [], 'platform')).toBe('eng');
  });

  it('reports exec for the root boundaries', () => {
    expect(activePreset(doc, ['data', 'platform'], null)).toBe('exec');
  });

  it('reports focus only for the group it is pointed at', () => {
    expect(activePreset(doc, ['data'], 'payments')).toBe('focus');
    expect(activePreset(doc, ['data'], 'platform')).toBe(null);
  });

  it('lights nothing for an arbitrary agent-set list (diagram view --collapsed)', () => {
    expect(activePreset(doc, ['payments'], 'payments')).toBe(null);
  });

  it('is null with no document', () => {
    expect(activePreset(null, [], null)).toBe(null);
  });
});

// The picker's action. Cycling reached the fourth group in four presses;
// this reaches it in one, and — the part that needed a new function — it can
// also say "none", which a cycle through N groups had no way to express.
describe('focusGroup — the picker picks', () => {
  it('focuses the named group, whatever the state was', () => {
    const next = focusGroup(doc, INITIAL_VIEW_STATE, 'data');
    expect(next.focus).toBe('data');
    expect(activePreset(doc, effectiveCollapsed(doc, next), next.focus)).toBe('focus');
  });

  it('goes straight to any group, with no steps in between', () => {
    const groups = focusCandidates(doc);
    expect(groups.length).toBeGreaterThan(1);
    const last = groups[groups.length - 1]!.id;
    expect(focusGroup(doc, INITIAL_VIEW_STATE, last).focus).toBe(last);
  });

  it('leaves focus entirely on null, opening everything', () => {
    const focused = focusGroup(doc, INITIAL_VIEW_STATE, 'data');
    const off = focusGroup(doc, focused, null);
    expect(off.focus).toBe(null);
    expect(off.local).toEqual([]);
    expect(activePreset(doc, effectiveCollapsed(doc, off), off.focus)).toBe('eng');
  });

  it('treats an id that is no longer a group as "no focus"', () => {
    // The agent can delete a container between the render and the click; the
    // view must not strand itself on a target that is gone.
    expect(focusGroup(doc, INITIAL_VIEW_STATE, 'gone').focus).toBe(null);
    // A NODE id is not a group either.
    expect(focusGroup(doc, INITIAL_VIEW_STATE, doc.nodes[0]!.id).focus).toBe(null);
  });

  it('never mutates the state it is handed', () => {
    const before = { ...INITIAL_VIEW_STATE };
    focusGroup(doc, INITIAL_VIEW_STATE, 'data');
    expect(INITIAL_VIEW_STATE).toEqual(before);
  });

  it('is a no-op with no document', () => {
    expect(focusGroup(null, INITIAL_VIEW_STATE, 'data')).toBe(INITIAL_VIEW_STATE);
  });
});

describe('[focus] with no mouse selection', () => {
  it('is disabled when the document has no groups', () => {
    const flat: GraphDoc = { ...doc, groups: [], nodes: [], edges: [] };
    expect(canFocus(flat)).toBe(false);
    expect(canFocus(doc)).toBe(true);
    expect(nextFocusTarget(flat, null)).toBe(null);
  });

  it('starts on the group the stored view is already focusing', () => {
    expect(inferredFocus(doc, ['data'])).toBe('payments');
    expect(inferredFocus(doc, [])).toBe('platform'); // no match -> first group
  });

  it('cycles through every group, nested ones included, and wraps', () => {
    let state = INITIAL_VIEW_STATE;
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      state = selectPreset(doc, state, 'focus');
      seen.push(focusTarget(doc, state));
      expect(activePreset(doc, effectiveCollapsed(doc, state), state.focus)).toBe(
        'focus',
      );
    }
    expect(seen).toEqual(['platform', 'payments', 'data', 'platform']);
  });

  it('walks backwards on a shift-activate', () => {
    const first = selectPreset(doc, INITIAL_VIEW_STATE, 'focus');
    const back = selectPreset(doc, first, 'focus', { reverse: true });
    expect(back.focus).toBe('data');
  });

  it('recovers when the agent deletes the focused group', () => {
    const gone: GraphDoc = {
      ...doc,
      groups: doc.groups.filter((g) => g.id !== 'payments'),
    };
    expect(focusTarget(gone, withState(['data'], 'payments'))).toBe('platform');
  });
});

describe('exec and eng presses', () => {
  it('set the override without touching the document', () => {
    const exec = selectPreset(doc, INITIAL_VIEW_STATE, 'exec');
    expect(collapsedKey(exec.local ?? [])).toBe(collapsedKey(['platform', 'data']));
    // The document object is untouched — §1.6: the browser never mutates it.
    expect(doc.collapsed).toEqual([]);

    const eng = selectPreset(doc, exec, 'eng');
    expect(eng.local).toEqual([]);
    expect(activePreset(doc, eng.local ?? [], null)).toBe('eng');
  });

  it('is a no-op with no document yet', () => {
    expect(selectPreset(null, INITIAL_VIEW_STATE, 'exec')).toBe(INITIAL_VIEW_STATE);
  });
});

describe('the agent wins: syncToDoc', () => {
  it('drops the local override when doc.collapsed changes', () => {
    const local = selectPreset(doc, INITIAL_VIEW_STATE, 'exec');
    const next = syncToDoc(
      local,
      collapsedKey(doc.collapsed),
      collapsedKey(docExec.collapsed),
    );
    expect(next).toEqual(INITIAL_VIEW_STATE);
    expect(effectiveCollapsed(docExec, next)).toEqual(['platform', 'data']);
  });

  it('keeps a human view through an unrelated patch (same collapsed set)', () => {
    const local = selectPreset(doc, INITIAL_VIEW_STATE, 'exec');
    const patched: GraphDoc = {
      ...doc,
      nodes: [...doc.nodes, { id: 'cache', label: 'Cache', type: 'cache', parent: null }],
    };
    const next = syncToDoc(
      local,
      collapsedKey(doc.collapsed),
      collapsedKey(patched.collapsed),
    );
    expect(next).toBe(local); // same object: no re-render, no view change
  });

  it('ignores mere reordering of the same collapsed set', () => {
    const local = selectPreset(doc, INITIAL_VIEW_STATE, 'eng');
    expect(syncToDoc(local, collapsedKey(['a', 'b']), collapsedKey(['b', 'a']))).toBe(
      local,
    );
  });

  it('does not reset on the very first document', () => {
    const local = selectPreset(doc, INITIAL_VIEW_STATE, 'exec');
    expect(syncToDoc(local, null, collapsedKey(docExec.collapsed))).toBe(local);
  });
});

// --- 3. the buttons in the slot -------------------------------------------

describe('ViewButtons in the StatusBar views slot (§8.4)', () => {
  const buttons = (
    props: Partial<Parameters<typeof ViewButtons>[0]> = {},
  ): string =>
    renderToStaticMarkup(
      createElement(ViewButtons, {
        active: 'eng' as const,
        onSelect: () => undefined,
        ...props,
      }),
    );

  const OPTIONS = [
    { id: 'payments', label: 'Payments' },
    { id: 'data', label: 'Data' },
  ];

  it('renders the two toggle presets as buttons, in order', () => {
    const html = buttons();
    for (const name of ['exec', 'eng']) {
      expect(html).toContain(`data-testid="view-button-${name}"`);
    }
    expect(html.indexOf('view-button-exec')).toBeLessThan(
      html.indexOf('view-button-eng'),
    );
    // focus is NOT a button any more: it is one picture per group, so the
    // control has to name which group before it can do anything.
    expect(html).not.toContain('view-button-focus');
    expect(html).toContain('data-testid="view-focus"');
  });

  /** The one <button> element carrying `data-testid="view-button-<name>"`. */
  const button = (html: string, name: string): string =>
    html
      .split('<button')
      .find((frag) => frag.includes(`view-button-${name}`)) ?? '';

  it('reports the active view through aria-pressed, not colour alone', () => {
    const html = buttons({ active: 'exec' });
    expect(button(html, 'exec')).toContain('aria-pressed="true"');
    expect(button(html, 'exec')).toContain('data-active="true"');
    expect(button(html, 'eng')).toContain('aria-pressed="false"');
  });

  it('lights nothing when the collapsed list matches no preset', () => {
    expect(buttons({ active: null })).not.toContain('aria-pressed="true"');
  });

  it('lists the numbered stages first, in numeric order', () => {
    // Document order interleaves them — "4 · Landing zone", "/raw/…",
    // "Source registry", "5 · Standardisation" — so the sequence a reader is
    // being asked to follow down the canvas was scattered through the picker.
    const jumbled = [
      { id: 'd', label: '4 · Landing zone' },
      { id: 'raw', label: '/raw/{source}/' },
      { id: 'sr', label: 'Source registry' },
      { id: 'e', label: '5 · Standardisation' },
      { id: 'a', label: '1 · Sources' },
      { id: 'b', label: '2 · Pull' },
    ];
    expect(sortFocusOptions(jumbled).map((o) => o.label)).toEqual([
      '1 · Sources',
      '2 · Pull',
      '4 · Landing zone',
      '5 · Standardisation',
      '/raw/{source}/',
      'Source registry',
    ]);
  });

  it('sorts stage 10 after stage 2, not between 1 and 2', () => {
    // The failure a plain string sort has, at exactly the size where a picker
    // starts to need sorting at all.
    const many = [
      { id: 'j', label: '10 · Ten' },
      { id: 'b', label: '2 · Two' },
      { id: 'a', label: '1 · One' },
    ];
    expect(sortFocusOptions(many).map((o) => o.label)).toEqual([
      '1 · One',
      '2 · Two',
      '10 · Ten',
    ]);
  });

  it('falls back to alphabetical when nothing is numbered', () => {
    const plain = [
      { id: 'b', label: 'Database VM' },
      { id: 'a', label: 'Provisioning' },
    ];
    expect(sortFocusOptions(plain).map((o) => o.id)).toEqual(['b', 'a']);
  });

  it('never mutates the list it is handed', () => {
    const input = [{ id: 'b', label: '2 · B' }, { id: 'a', label: '1 · A' }];
    sortFocusOptions(input);
    expect(input.map((o) => o.id)).toEqual(['b', 'a']);
  });

  it('offers every group, plus a way back out, in one control', () => {
    // The point of the change: reaching the fourth group used to take four
    // presses, with the target only readable as it went past.
    const html = buttons({ focusOptions: OPTIONS });
    expect(html).toContain('>no focus<');
    expect(html).toContain('>Payments<');
    expect(html).toContain('>Data<');
    // "no focus" comes first — the way out is the resting state — and stays
    // there whatever the sort does to the groups behind it.
    expect(html.indexOf('>no focus<')).toBeLessThan(html.indexOf('>Data<'));
    expect(html.indexOf('>no focus<')).toBeLessThan(html.indexOf('>Payments<'));
  });

  it('selects the focused group, and only while the view IS focused', () => {
    // React marks the chosen option with `selected`, rather than putting a
    // value on the <select> — so that is what the assertion looks at.
    const on = buttons({ active: 'focus', focusId: 'data', focusOptions: OPTIONS });
    expect(on).toContain('<option value="data" selected');
    expect(on).toContain('data-active="true"');
    // The moment the picture stops being a focus view the picker says so,
    // even though the remembered target is unchanged. A select still claiming
    // a focus the canvas has left is worse than no indicator at all.
    const off = buttons({ active: 'eng', focusId: 'data', focusOptions: OPTIONS });
    expect(off).toContain(`<option value="${NO_FOCUS}" selected`);
    expect(off).not.toContain('<option value="data" selected');
    // Scoped to the SELECT: with active 'eng' the [eng] button is legitimately
    // marked active, so a whole-markup assertion would be testing the wrong
    // element.
    expect(off.slice(off.indexOf('<select'))).not.toContain('data-active="true"');
  });

  it('disables the picker when there is nothing to focus', () => {
    const off = buttons({ focusOptions: [] });
    const select = off.slice(off.indexOf('<select'));
    expect(select).toContain('disabled');
    expect(button(off, 'exec')).not.toContain('disabled');
  });

  it('shortens a long group label so the 28px strip never reflows', () => {
    expect(focusOptionText('A very long boundary name')).toBe('A very long boundary…');
    expect(focusOptionText('Payments')).toBe('Payments');
    expect(focusOptionText('   ')).toBe('(unnamed group)');
  });

  it('uses real form controls, so Tab and the arrow keys just work', () => {
    const html = buttons({ focusOptions: OPTIONS });
    expect(html).toContain('<button type="button"');
    expect(html).toContain('<select');
    // The select says what it is even when it is showing a group name — a
    // bare dropdown reading "Payments" could be anything.
    expect(html).toContain('<label');
    expect(html).toContain('>focus<');
  });

  it('appears inside the status bar only when the slot is filled', () => {
    const bar = (views?: ReactElement): string =>
      renderToStaticMarkup(
        createElement(StatusBar, {
          title: 'Views fixture',
          counts: { nodes: 4, groups: 3, edges: 3 },
          connection: 'connected' as const,
          lastUpdate: 1_000,
          ...(views === undefined ? {} : { views }),
        }),
      );
    expect(bar()).not.toContain('view-slot');
    const filled = bar(
      createElement(ViewButtons, { active: 'exec' as const, onSelect: () => undefined }),
    );
    expect(filled).toContain('data-testid="view-slot"');
    expect(filled).toContain('data-testid="view-button-exec"');
  });
});

// --- 4. what the hook actually hands downstream ----------------------------
//
// The regression this section exists for: the hook used to return only the
// order-insensitive `key` and rebuild the id array by SPLITTING it. The key is
// joined with a NUL byte and was split on a space, so any view collapsing two
// or more groups reconstructed ONE bogus id ("data\x00platform"), deriveView
// ignored it (decision 6) and drew the FULL graph — while the [exec] button
// still rendered pressed, because the bogus one-element list keys identically
// to the real two-element one. Nothing here may go through the key again:
// resolveView produces the array and the key together, from the same array.

describe('resolveView hands downstream the collapsed ARRAY (§7)', () => {
  it('collapses BOTH root boundaries when [exec] is pressed', () => {
    const pressed = selectPreset(doc, INITIAL_VIEW_STATE, 'exec', {});
    const view = resolveView(doc, pressed);

    expect([...view.collapsed].sort()).toEqual(['data', 'platform']);
    expect(view.active).toBe('exec');

    // The picture the viewer draws from exactly that array.
    const drawn = deriveView(doc, view.collapsed);
    expect(drawn.nodes.map((n) => n.id).sort()).toEqual(['cdn', 'data', 'platform']);
    expect(drawn.groups).toEqual([]);
  });

  it('collapses both on FIRST PAINT from the agent-stored view', () => {
    const view = resolveView(docExec, INITIAL_VIEW_STATE);
    expect([...view.collapsed].sort()).toEqual(['data', 'platform']);
    const drawn = deriveView(docExec, view.collapsed);
    expect(drawn.groups).toEqual([]);
    expect(drawn.nodes.some((n) => n.id === 'api')).toBe(false);
  });

  it('never reconstructs the array from the key — the key is lossy', () => {
    const view = resolveView(docExec, INITIAL_VIEW_STATE);
    // The exact shape of the old bug: the key is ONE token under any
    // whitespace split, and a list built that way names no group at all.
    expect(view.key.split(' ')).toHaveLength(1);
    expect(view.collapsed).toHaveLength(2);
    expect(deriveView(docExec, view.key.split(' ')).groups).toHaveLength(3);
  });

  it('keeps the array identity stable while the SET is unchanged', () => {
    const a = resolveView(docExec, INITIAL_VIEW_STATE);
    const b = resolveView(docExec, INITIAL_VIEW_STATE);
    // Different objects (it is pure), but the same key — which is what the
    // hook memoises on, so the layout is not re-requested per render.
    expect(b.key).toBe(a.key);
    expect(resolveView(doc, INITIAL_VIEW_STATE).key).not.toBe(a.key);
  });

  it('reports the active preset and its focus target from the same pass', () => {
    const focused = focusGroup(doc, INITIAL_VIEW_STATE, 'data');
    const view = resolveView(doc, focused);
    expect(view.active).toBe('focus');
    expect(view.focus).toBe('data');
    // The label is NOT carried here any more. It existed for the old button's
    // text, and the picker reads labels straight off `focusOptions`; two
    // sources for one string is one that can go stale.
    expect(doc.groups.some((g) => g.id === view.focus)).toBe(true);
  });
});

// --- 5. a collapsed boundary must not read as a third-party cloud ----------

describe('a collapsed group is drawn as a boundary, not as `external` (§7, §8.2)', () => {
  const drawn = deriveView(doc, ['platform']);
  const standIn = drawn.nodes.find((n) => n.id === 'platform') as GNode;

  it('is still typed `external` — the type enum is a published contract', () => {
    expect(standIn.type).toBe('external');
    expect(isCollapsedGroupNode(standIn)).toBe(true);
    expect(collapsedGroupKind(standIn)).toBe('vpc');
  });

  it('picks the collapsed-boundary glyph, not the external cloud', () => {
    expect(nodeIcon(standIn)).toBe(CollapsedGroupIcon);
    const genuine = doc.nodes.find((n) => n.id === 'cdn') as GNode;
    expect(nodeIcon(genuine)).toBe(NODE_ICONS.external);
    expect(nodeIcon(standIn)).not.toBe(nodeIcon(genuine));
  });

  it('does not draw the cloud path over the reader’s own VPC', () => {
    const rect = { x: 0, y: 0, width: 200, height: 48 };
    const svg = renderToStaticMarkup(
      createElement(NodeContent, { node: standIn, rect }),
    );
    // ExternalIcon's cloud outline, verbatim from icons.tsx.
    expect(svg).not.toContain('M6 15.5h8.3');
    expect(svg).toContain('data-collapsed-group="true"');
    expect(svg).toContain('stroke-dasharray');
  });

  it('says "collapsed vpc" in the hover panel instead of listing a meta row', () => {
    expect(kindText(standIn)).toBe('collapsed vpc');
    expect(visibleMeta(standIn)).toEqual([]);
    // An author's own metadata is untouched.
    const authored: GNode = { ...standIn, meta: { ...standIn.meta, owner: 'sre' } };
    expect(visibleMeta(authored)).toEqual([['owner', 'sre']]);
    // And a node that is not a stand-in still reports its type.
    expect(kindText(doc.nodes.find((n) => n.id === 'cdn') as GNode)).toBe('external');
  });
});
