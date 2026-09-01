// tests/sidebar.test.ts — the view panel and the bottom strip's readout.
//
// The split under test is the design: the SIDEBAR carries the controls that
// change which elements are drawn (views, grain, containers) and the STRIP
// carries the state of the session plus a readout of the view. Both drive the
// same local override, so a change made in one is visible in the other.
//
// Rendered with react-dom/server like tests/views.test.ts — no DOM, no click
// simulation: every rule is a pure function and is driven directly.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GraphDoc } from '@diagram-engine/core';
import { ContainerTree, contentsText } from '../src/render/ContainerTree.js';
import { GrainControl, depthCountText, depthLabel } from '../src/render/GrainControl.js';
import { Sidebar } from '../src/render/Sidebar.js';
import { StatusBar } from '../src/render/StatusBar.js';
import {
  INITIAL_VIEW_STATE,
  activeDepth,
  ancestorIds,
  clearSelection,
  isolateCollapsed,
  revealGroup,
  rowHint,
  rowStateText,
  selectedIds,
  toggleSelected,
  containerRows,
  depthOptions,
  effectiveCollapsed,
  selectDepth,
  toggleGroup,
  viewSummaryText,
} from '../src/view/viewState.js';

/**
 * Four stages inside one wrapper, one of them nested one deeper — the shape
 * the whole feature exists for, where "collapse the top-level groups" gives
 * you a single useless box.
 */
function wrapped(): GraphDoc {
  return {
    schemaVersion: 1,
    title: 'Aggregator',
    direction: 'DOWN',
    collapsed: [],
    nodes: [
      { id: 'harvester', label: 'Harvester', type: 'service', parent: 'pull' },
      { id: 'file', label: 'file', type: 'storage', parent: 'item-folder' },
    ],
    groups: [
      { id: 'registry', label: 'Registry', kind: 'generic', parent: null },
      { id: 'sources', label: 'Sources', kind: 'generic', parent: 'registry' },
      { id: 'pull', label: 'Pull', kind: 'generic', parent: 'registry' },
      { id: 'landing', label: 'Landing', kind: 'generic', parent: 'registry' },
      { id: 'item-folder', label: 'Item folder', kind: 'generic', parent: 'landing' },
    ],
    edges: [],
  };
}

describe('grain: levels of container detail', () => {
  it('offers every level that holds a container, and no more', () => {
    const options = depthOptions(wrapped());
    expect(options.map((o) => o.depth)).toEqual([0, 1, 2]);
    expect(options.map((o) => o.count)).toEqual([1, 3, 1]);
  });

  it('offers nothing for a document with no containers', () => {
    const flat: GraphDoc = { ...wrapped(), groups: [], nodes: [] };
    expect(depthOptions(flat)).toEqual([]);
  });

  it('selecting a level collapses exactly that level', () => {
    const doc = wrapped();
    const state = selectDepth(doc, INITIAL_VIEW_STATE, 1);
    expect(effectiveCollapsed(doc, state)).toEqual(['sources', 'pull', 'landing']);
    expect(activeDepth(doc, effectiveCollapsed(doc, state))).toBe(1);
  });

  it('reports no level once a single container is opened by hand', () => {
    const doc = wrapped();
    const level = selectDepth(doc, INITIAL_VIEW_STATE, 1);
    const opened = toggleGroup(doc, level, 'pull');
    expect(activeDepth(doc, effectiveCollapsed(doc, opened))).toBeNull();
  });

  it('renders one radio per level, with the active one checked', () => {
    const doc = wrapped();
    const html = renderToStaticMarkup(
      createElement(GrainControl, {
        options: depthOptions(doc),
        active: 1,
        onSelect: () => {},
      }),
    );
    expect(html).toContain('data-testid="grain-level-0"');
    expect(html).toContain('data-testid="grain-level-2"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(depthLabel(1));
    expect(html).toContain(depthCountText(3));
  });

  it('says so rather than rendering an empty control', () => {
    const html = renderToStaticMarkup(
      createElement(GrainControl, { options: [], active: null, onSelect: () => {} }),
    );
    expect(html).toContain('data-testid="grain-empty"');
  });
});

describe('containers: one boundary at a time', () => {
  it('toggling one container leaves the others alone', () => {
    const doc = wrapped();
    const level = selectDepth(doc, INITIAL_VIEW_STATE, 1);
    const opened = toggleGroup(doc, level, 'pull');
    expect(effectiveCollapsed(doc, opened)).toEqual(['sources', 'landing']);

    const shutAgain = toggleGroup(doc, opened, 'pull');
    expect(new Set(effectiveCollapsed(doc, shutAgain))).toEqual(
      new Set(['sources', 'landing', 'pull']),
    );
  });

  it('ignores an id that is not a container', () => {
    const doc = wrapped();
    expect(toggleGroup(doc, INITIAL_VIEW_STATE, 'harvester')).toBe(INITIAL_VIEW_STATE);
  });

  it('rows carry level, state and what is inside', () => {
    const doc = wrapped();
    const rows = containerRows(doc, ['landing']);
    const byId = new Map(rows.map((r) => [r.group.id, r]));

    expect(byId.get('registry')?.depth).toBe(0);
    expect(byId.get('item-folder')?.depth).toBe(2);
    expect(byId.get('landing')?.collapsed).toBe(true);
    expect(byId.get('registry')?.groupCount).toBe(3);
    expect(byId.get('pull')?.nodeCount).toBe(1);
  });

  it('marks a row whose ancestor is collapsed rather than dropping it', () => {
    const rows = containerRows(wrapped(), ['landing']);
    const nested = rows.find((r) => r.group.id === 'item-folder');
    expect(nested?.hiddenByAncestor).toBe(true);
    expect(nested?.collapsed).toBe(false);
  });

  it('renders the tree with levels, state and the hidden marker', () => {
    const html = renderToStaticMarkup(
      createElement(ContainerTree, {
        rows: containerRows(wrapped(), ['landing']),
        onToggle: () => {},
        onReveal: () => {},
        onSelect: () => {},
      }),
    );
    expect(html).toContain('data-testid="container-row-registry"');
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('data-hidden-by-ancestor="true"');
    expect(html).toContain('aria-level="3"'); // item-folder, two levels in
    expect(html).toContain(contentsText(containerRows(wrapped(), [])[2]!));
    // Two controls per row: go there, or shut just this one.
    expect(html).toContain('data-testid="container-goto-registry"');
    expect(html).toContain('data-testid="container-toggle-registry"');
    // A row that is not on screen is marked, never disabled — pressing it is
    // how you get to it.
    expect(html).not.toContain('disabled');
  });
});

describe('the split between the panel and the strip', () => {
  it('the panel carries the two control sections, and no preset buttons', () => {
    const doc = wrapped();
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        depths: depthOptions(doc),
        activeDepth: 1,
        onSelectDepth: () => {},
        containers: containerRows(doc, []),
        onToggleContainer: () => {},
        onRevealContainer: () => {},
        onSelectContainer: () => {},
        selectedCount: 0,
        onClearSelection: () => {},
        followingDocument: true,
        onClose: () => {},
      }),
    );
    expect(html).toContain('data-testid="sidebar-grain"');
    expect(html).toContain('data-testid="sidebar-containers"');
    // The presets live in the status strip only — a second copy here competed
    // with the container list rather than adding anything.
    expect(html).not.toContain('data-testid="sidebar-views"');
    expect(html).not.toContain('data-testid="view-buttons"');
    expect(html).toContain('Following the document');
  });

  it('the panel admits when the view is local to the tab', () => {
    const doc = wrapped();
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        depths: depthOptions(doc),
        activeDepth: null,
        onSelectDepth: () => {},
        containers: containerRows(doc, []),
        onToggleContainer: () => {},
        onRevealContainer: () => {},
        onSelectContainer: () => {},
        selectedCount: 0,
        onClearSelection: () => {},
        followingDocument: false,
        onClose: () => {},
      }),
    );
    expect(html).toContain('Local to this tab');
  });

  it('the strip reads the view out in the same words', () => {
    const doc = wrapped();
    expect(viewSummaryText(doc, [])).toBe('all containers open');
    expect(viewSummaryText(doc, ['sources', 'pull', 'landing'])).toBe(
      'level 1 · 3 of 5 containers collapsed',
    );
    // A hand-picked set is not a level, and must not claim to be one.
    expect(viewSummaryText(doc, ['sources'])).toBe('1 of 5 containers collapsed');
    expect(viewSummaryText({ ...doc, groups: [] }, [])).toBe('no containers');
  });

  it('the strip renders the readout and the panel toggle in their slots', () => {
    const html = renderToStaticMarkup(
      createElement(StatusBar, {
        title: 'Aggregator',
        counts: { nodes: 2, groups: 5, edges: 0 },
        connection: 'connected',
        lastUpdate: Date.now(),
        viewSummary: 'level 1 · 3 of 5 containers collapsed',
        panel: createElement('button', { 'data-testid': 'panel-toggle' }, '☰'),
      }),
    );
    expect(html).toContain('data-testid="panel-slot"');
    expect(html).toContain('data-testid="panel-toggle"');
    expect(html).toContain('data-testid="view-summary"');
    expect(html).toContain('level 1 · 3 of 5 containers collapsed');
  });

  it('renders neither slot when the bar is given neither — every old caller', () => {
    const html = renderToStaticMarkup(
      createElement(StatusBar, {
        title: 'Aggregator',
        counts: { nodes: 2, groups: 5, edges: 0 },
        connection: 'connected',
        lastUpdate: null,
      }),
    );
    expect(html).not.toContain('data-testid="panel-slot"');
    expect(html).not.toContain('data-testid="view-summary"');
  });
});

describe('go to a container', () => {
  it('opens every boundary hiding it, not just the container itself', () => {
    const doc = wrapped();
    // Everything shut at the top: item-folder is three boundaries deep.
    const shut = selectDepth(doc, INITIAL_VIEW_STATE, 0);
    expect(containerRows(doc, effectiveCollapsed(doc, shut)).find(
      (r) => r.group.id === 'item-folder',
    )?.hiddenByAncestor).toBe(true);

    const there = revealGroup(doc, shut, 'item-folder');
    const rows = containerRows(doc, effectiveCollapsed(doc, there));
    const target = rows.find((r) => r.group.id === 'item-folder');
    expect(target?.hiddenByAncestor).toBe(false);
    expect(target?.collapsed).toBe(false);
  });

  it('leaves unrelated containers exactly as they were — it only opens', () => {
    const doc = wrapped();
    const level = selectDepth(doc, INITIAL_VIEW_STATE, 1); // sources, pull, landing
    const there = revealGroup(doc, level, 'item-folder');
    // landing had to open (it is an ancestor); the two siblings did not move.
    expect(effectiveCollapsed(doc, there)).toEqual(['sources', 'pull']);
  });

  it('is a no-op for an id that is not a container', () => {
    const doc = wrapped();
    expect(revealGroup(doc, INITIAL_VIEW_STATE, 'harvester')).toBe(INITIAL_VIEW_STATE);
  });

  it('lists the ancestors nearest first', () => {
    expect(ancestorIds(wrapped(), 'item-folder')).toEqual(['landing', 'registry']);
    expect(ancestorIds(wrapped(), 'registry')).toEqual([]);
  });
});

describe('multi-select: show only these containers', () => {
  it('opens the picked containers and collapses every other one', () => {
    const doc = wrapped();
    const one = toggleSelected(doc, INITIAL_VIEW_STATE, 'pull');
    expect(effectiveCollapsed(doc, one)).toEqual([
      'sources',
      'landing',
      'item-folder',
    ]);

    const two = toggleSelected(doc, one, 'landing');
    // Both picked containers are open; only the ones nobody picked are shut.
    expect(effectiveCollapsed(doc, two)).toEqual(['sources', 'item-folder']);
    expect(selectedIds(two)).toEqual(['pull', 'landing']);
  });

  it('keeps the boundaries above a pick open, or the pick is invisible', () => {
    const doc = wrapped();
    const state = toggleSelected(doc, INITIAL_VIEW_STATE, 'item-folder');
    const collapsed = effectiveCollapsed(doc, state);
    // registry and landing enclose it, so they stay open.
    expect(collapsed).not.toContain('registry');
    expect(collapsed).not.toContain('landing');
    expect(collapsed).toEqual(['sources', 'pull']);
  });

  it('unpicking the last one shows everything, not nothing', () => {
    const doc = wrapped();
    const on = toggleSelected(doc, INITIAL_VIEW_STATE, 'pull');
    const off = toggleSelected(doc, on, 'pull');
    expect(selectedIds(off)).toEqual([]);
    expect(effectiveCollapsed(doc, off)).toEqual([]);
  });

  it('show all clears the selection', () => {
    const doc = wrapped();
    const on = toggleSelected(doc, INITIAL_VIEW_STATE, 'pull');
    const cleared = clearSelection(on);
    expect(selectedIds(cleared)).toEqual([]);
    expect(effectiveCollapsed(doc, cleared)).toEqual([]);
  });

  it('choosing a level ends the selection rather than leaving a stale highlight', () => {
    const doc = wrapped();
    const picked = toggleSelected(doc, INITIAL_VIEW_STATE, 'pull');
    const levelled = selectDepth(doc, picked, 1);
    expect(selectedIds(levelled)).toEqual([]);

    const revealed = revealGroup(doc, picked, 'item-folder');
    expect(selectedIds(revealed)).toEqual([]);
  });

  it('ignores an id that is not a container', () => {
    const doc = wrapped();
    expect(toggleSelected(doc, INITIAL_VIEW_STATE, 'harvester')).toBe(INITIAL_VIEW_STATE);
  });

  it('marks the picked rows, and the tree renders a checkbox per row', () => {
    const doc = wrapped();
    const rows = containerRows(doc, isolateCollapsed(doc, ['pull']), ['pull']);
    expect(rows.find((r) => r.group.id === 'pull')?.selected).toBe(true);
    expect(rows.find((r) => r.group.id === 'sources')?.selected).toBe(false);

    const html = renderToStaticMarkup(
      createElement(ContainerTree, { rows, onToggle: () => {}, onReveal: () => {}, onSelect: () => {} }),
    );
    expect(html).toContain('data-testid="container-select-pull"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-checked="true"');
  });

  it('the panel offers a way out only while a selection is active', () => {
    const doc = wrapped();
    const props = {
      depths: depthOptions(doc),
      activeDepth: null,
      onSelectDepth: () => {},
      containers: containerRows(doc, [], []),
      onToggleContainer: () => {},
      onRevealContainer: () => {},
      onSelectContainer: () => {},
      onClearSelection: () => {},
      followingDocument: false,
      onClose: () => {},
    };
    const none = renderToStaticMarkup(createElement(Sidebar, { ...props, selectedCount: 0 }));
    expect(none).not.toContain('data-testid="selection-clear"');

    const some = renderToStaticMarkup(createElement(Sidebar, { ...props, selectedCount: 2 }));
    expect(some).toContain('data-testid="selection-clear"');
    expect(some).toContain('2 shown, the rest collapsed');
  });
});

describe('every row says what its appearance means', () => {
  it('a faded row names the container that is hiding it', () => {
    const rows = containerRows(wrapped(), ['landing']);
    const nested = rows.find((r) => r.group.id === 'item-folder')!;

    expect(nested.hiddenBy).toEqual({ id: 'landing', label: 'Landing' });
    expect(rowStateText(nested)).toBe('not shown');
    // The hint has to name the thing to open, not describe the shade.
    expect(rowHint(nested)).toContain('“Landing” is collapsed around it');
    expect(rowHint(nested)).toContain('Click this name to go there');
  });

  it('names the NEAREST collapsed container, not the outermost', () => {
    // Both registry and landing shut: opening registry alone is not enough.
    const rows = containerRows(wrapped(), ['registry', 'landing']);
    expect(rows.find((r) => r.group.id === 'item-folder')?.hiddenBy?.id).toBe('landing');
  });

  it('a collapsed but visible row says its insides are hidden', () => {
    const rows = containerRows(wrapped(), ['pull']);
    const row = rows.find((r) => r.group.id === 'pull')!;
    expect(row.hiddenBy).toBeNull();
    expect(rowStateText(row)).toBe('collapsed');
    expect(rowHint(row)).toContain('drawn as a single box');
  });

  it('a ticked row explains why everything else is shut', () => {
    const doc = wrapped();
    const rows = containerRows(doc, isolateCollapsed(doc, ['pull']), ['pull']);
    const hint = rowHint(rows.find((r) => r.group.id === 'pull')!);
    expect(hint).toContain('one of the ticked containers');
    expect(hint).toContain('Untick it');
  });

  it('an ordinary open row says what is inside it', () => {
    const rows = containerRows(wrapped(), []);
    const row = rows.find((r) => r.group.id === 'pull')!;
    expect(rowStateText(row)).toBe('1 node');
    expect(rowHint(row)).toContain('is open, showing 1 node');
  });

  it('the rendered row carries the hint on the row, the name and the chip', () => {
    const html = renderToStaticMarkup(
      createElement(ContainerTree, {
        rows: containerRows(wrapped(), ['landing']),
        onToggle: () => {},
        onReveal: () => {},
        onSelect: () => {},
      }),
    );
    expect(html).toContain('data-testid="container-state-item-folder"');
    // Three hoverable surfaces, one sentence: whatever the pointer lands on,
    // the same explanation appears.
    const hint = 'is collapsed around it';
    expect(html.split(hint).length - 1).toBeGreaterThanOrEqual(3);
  });
});
