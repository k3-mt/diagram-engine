// tests/depth.test.ts — the view stored as a RULE (a container level) rather
// than a list of ids: what a depth resolves to, what `exec` means once a
// diagram is wrapped in a single outer boundary, and the reconcile pass that
// keeps doc.collapsed true after the structure moves under it.

import { describe, expect, it } from 'vitest';
import {
  collapsedAtDepth,
  depthOf,
  execDepth,
  groupsAtDepth,
  maxGroupDepth,
  reconcileView,
} from '../src/view/depth.js';
import { resolvePreset } from '../src/view/presets.js';
import { applyPatch } from '../src/document/apply.js';
import { doc, group, node } from './helpers.js';

/**
 * Two root boundaries, each with a child — the shape the old list-based `exec`
 * was written for, and the one whose behaviour must not change.
 *
 *   prod (root)        staging (root)
 *   └── vpc-private    └── vpc-stage
 */
function twoRoots() {
  return doc({
    groups: [
      group('prod', { kind: 'account' }),
      group('vpc-private', { kind: 'vpc', parent: 'prod' }),
      group('staging', { kind: 'account' }),
      group('vpc-stage', { kind: 'vpc', parent: 'staging' }),
    ],
    nodes: [node('postgres', { type: 'database', parent: 'vpc-private' })],
  });
}

/**
 * The same four stages, wrapped in ONE outer container — the case that made
 * the old `exec` collapse the whole diagram to a single box.
 *
 *   registry (root)
 *   ├── sources ├── pull ├── engine └── landing
 *                                        └── item-folder
 */
function wrapped() {
  return doc({
    groups: [
      group('registry'),
      group('sources', { parent: 'registry' }),
      group('pull', { parent: 'registry' }),
      group('engine', { parent: 'registry' }),
      group('landing', { parent: 'registry' }),
      group('item-folder', { parent: 'landing' }),
    ],
    nodes: [node('harvester', { parent: 'pull' })],
  });
}

describe('depthOf', () => {
  it('counts the boundaries enclosing a group or a node', () => {
    const d = wrapped();
    expect(depthOf(d, 'registry')).toBe(0);
    expect(depthOf(d, 'landing')).toBe(1);
    expect(depthOf(d, 'item-folder')).toBe(2);
    expect(depthOf(d, 'harvester')).toBe(2);
  });

  it('treats an unknown id as top level rather than throwing', () => {
    expect(depthOf(wrapped(), 'no-such-thing')).toBe(0);
  });

  it('terminates on a parent cycle instead of spinning', () => {
    const cyclic = doc({
      groups: [group('a', { parent: 'b' }), group('b', { parent: 'a' })],
    });
    // One step, then the walk sees an id it has already visited and stops.
    expect(depthOf(cyclic, 'a')).toBe(1);
  });
});

describe('collapsedAtDepth', () => {
  it('collapses exactly the level asked for, not everything below it', () => {
    expect(collapsedAtDepth(wrapped(), 0)).toEqual(['registry']);
    expect(collapsedAtDepth(wrapped(), 1)).toEqual([
      'sources',
      'pull',
      'engine',
      'landing',
    ]);
    expect(collapsedAtDepth(wrapped(), 2)).toEqual(['item-folder']);
  });

  it('collapses nothing past the bottom of the tree', () => {
    expect(collapsedAtDepth(wrapped(), 3)).toEqual([]);
    expect(collapsedAtDepth(doc(), 0)).toEqual([]);
  });

  it('reports the tree depth', () => {
    expect(maxGroupDepth(wrapped())).toBe(2);
    expect(maxGroupDepth(doc())).toBe(0);
    expect(groupsAtDepth(twoRoots(), 0)).toEqual(['prod', 'staging']);
  });
});

describe('execDepth', () => {
  it('is the root level when the top level already divides the system', () => {
    expect(execDepth(twoRoots())).toBe(0);
  });

  it('skips a singleton wrapper and takes the level that divides', () => {
    expect(execDepth(wrapped())).toBe(1);
  });

  it('falls back to the root for a straight chain of nesting', () => {
    const chain = doc({
      groups: [group('a'), group('b', { parent: 'a' }), group('c', { parent: 'b' })],
    });
    expect(execDepth(chain)).toBe(0);
  });

  it('falls back to the root for a document with no groups', () => {
    expect(execDepth(doc())).toBe(0);
  });
});

describe('preset exec, resolved through depth', () => {
  it('still collapses the root boundaries when there are several', () => {
    expect(resolvePreset(twoRoots(), { preset: 'exec' })).toEqual({
      ok: true,
      collapsed: ['prod', 'staging'],
    });
  });

  it('collapses the stages, not the lone wrapper around them', () => {
    expect(resolvePreset(wrapped(), { preset: 'exec' })).toEqual({
      ok: true,
      collapsed: ['sources', 'pull', 'engine', 'landing'],
    });
  });
});

describe('reconcileView', () => {
  it('leaves a document with no rule exactly as it was', () => {
    const explicit = doc({ ...wrapped(), collapsed: ['landing'] });
    expect(reconcileView(explicit)).toBe(explicit);
  });

  it('returns the same object when the list already matches the rule', () => {
    const d = { ...wrapped(), collapsed: ['registry'], view: { depth: 0 } };
    expect(reconcileView(d)).toBe(d);
  });

  it('rewrites a stale list from the stored rule', () => {
    const d = { ...wrapped(), collapsed: ['registry'], view: { depth: 1 } };
    expect(reconcileView(d).collapsed).toEqual(['sources', 'pull', 'engine', 'landing']);
  });
});

describe('applyPatch keeps a stored rule true', () => {
  it('collapses a stage added after the view was set', () => {
    const before = { ...wrapped(), collapsed: collapsedAtDepth(wrapped(), 1), view: { depth: 1 } };
    const r = applyPatch(before, {
      summary: 'add a fifth stage',
      ops: [
        {
          op: 'addGroup',
          group: { id: 'publish', label: 'Publish', kind: 'generic', parent: 'registry' },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.collapsed).toContain('publish');
  });

  it('follows a group that is reparented to another level', () => {
    const before = { ...wrapped(), collapsed: collapsedAtDepth(wrapped(), 1), view: { depth: 1 } };
    const r = applyPatch(before, {
      summary: 'move the item folder up a level',
      ops: [{ op: 'updateGroup', id: 'item-folder', changes: { parent: 'registry' } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // It sits at depth 1 now, so the same rule collapses it.
    expect(r.doc.collapsed).toContain('item-folder');
  });

  it('does not touch an explicit list', () => {
    const before = { ...wrapped(), collapsed: ['landing'] };
    const r = applyPatch(before, {
      summary: 'add a fifth stage',
      ops: [
        {
          op: 'addGroup',
          group: { id: 'publish', label: 'Publish', kind: 'generic', parent: 'registry' },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.collapsed).toEqual(['landing']);
    expect(r.doc.view).toBeUndefined();
  });
});
