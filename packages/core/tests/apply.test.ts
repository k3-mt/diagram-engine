// M1 Step 5 — applyPatch atomicity (spec §3.4), the three ID coercions
// (spec §3.5), and removeGroup semantics (spec §3.2).

import { describe, expect, it } from 'vitest';
import { applyPatch, type GraphDoc, type GraphPatch } from '../src/index.js';
import { doc, edge, group, node } from './helpers.js';

function patch(ops: GraphPatch['ops']): GraphPatch {
  return { ops, summary: 'test patch' };
}

function baseDoc(): GraphDoc {
  return doc({
    nodes: [node('auth'), node('postgres', { type: 'database' })],
    edges: [edge('e1', 'auth', 'postgres', { label: 'reads' })],
  });
}

describe('applyPatch atomicity (spec §3.4)', () => {
  it('one bad op among good ops changes nothing and returns all op errors', () => {
    const before = baseDoc();
    const frozen = structuredClone(before);
    const r = applyPatch(
      before,
      patch([
        { op: 'addNode', node: node('kafka', { type: 'queue' }) }, // good
        { op: 'removeNode', id: 'ghost' }, // bad
        { op: 'setTitle', title: 'New title' }, // good
        { op: 'updateEdge', id: 'zz-unknown', changes: { label: 'writes' } }, // bad
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      'op 1 (removeNode): unknown node "ghost".',
      'op 3 (updateEdge): unknown edge "zz-unknown".',
    ]);
    // never partially applied: the input document is untouched
    expect(before).toEqual(frozen);
  });

  it('a patch that breaks an invariant is rejected whole with the V error', () => {
    const before = baseDoc();
    const frozen = structuredClone(before);
    const r = applyPatch(
      before,
      patch([
        { op: 'addNode', node: node('kafka', { type: 'queue' }) },
        { op: 'addEdge', edge: edge('e2', 'kafka', 'redis') }, // unknown endpoint
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Spec §4.1 rejection shape: a validation-pass error is attributed back to
    // the op that introduced the offending element, so a ten-op patch tells the
    // agent WHICH op to edit and not merely which id is wrong.
    expect(r.errors).toContain('op 1 (addEdge): edge "e2" references unknown node "redis".');
    expect(before).toEqual(frozen);
  });

  it('a good patch returns a new doc and leaves the input untouched', () => {
    const before = baseDoc();
    const frozen = structuredClone(before);
    const r = applyPatch(
      before,
      patch([{ op: 'addNode', node: node('kafka', { type: 'queue' }) }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes.map((n) => n.id)).toEqual(['auth', 'postgres', 'kafka']);
    expect(r.summary).toBe('+1 node');
    expect(r.notes).toEqual([]);
    expect(before).toEqual(frozen);
  });
});

describe('ID collision coercion (spec §3.5)', () => {
  it('addNode with an existing id becomes updateNode, with a note', () => {
    const r = applyPatch(
      baseDoc(),
      patch([
        { op: 'addNode', node: node('auth', { label: 'Auth Service', note: 'JWT issuer' }) },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notes).toEqual(['coerced addNode "auth" to updateNode (id exists)']);
    // updated in place, not duplicated
    expect(r.doc.nodes.filter((n) => n.id === 'auth')).toHaveLength(1);
    expect(r.doc.nodes.find((n) => n.id === 'auth')).toMatchObject({
      label: 'Auth Service',
      note: 'JWT issuer',
    });
  });

  it('addGroup with an existing id becomes updateGroup, with a note', () => {
    const before = doc({ groups: [group('vpc-private', { kind: 'generic' })] });
    const r = applyPatch(
      before,
      patch([
        { op: 'addGroup', group: group('vpc-private', { kind: 'vpc', label: 'Private VPC' }) },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notes).toEqual(['coerced addGroup "vpc-private" to updateGroup (id exists)']);
    expect(r.doc.groups).toHaveLength(1);
    expect(r.doc.groups[0]).toMatchObject({ kind: 'vpc', label: 'Private VPC' });
  });

  it('addEdge with an existing id and different endpoints gets a fresh e-<n> id', () => {
    const before = doc({
      nodes: [node('auth'), node('postgres'), node('kafka')],
      edges: [edge('e1', 'auth', 'postgres')],
    });
    const r = applyPatch(
      before,
      patch([{ op: 'addEdge', edge: edge('e1', 'auth', 'kafka', { label: 'publishes' }) }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notes).toEqual([
      'coerced addEdge "e1" to new id "e-2" (id exists with different endpoints)',
    ]);
    expect(r.doc.edges.map((e) => e.id)).toEqual(['e1', 'e-2']);
    expect(r.doc.edges[1]).toMatchObject({ from: 'auth', to: 'kafka', label: 'publishes' });
  });

  it('addEdge with an existing id and identical endpoints updates in place, no note', () => {
    // Spec leaves this case undefined; implemented as an in-place property update.
    const before = baseDoc();
    const r = applyPatch(
      before,
      patch([{ op: 'addEdge', edge: edge('e1', 'auth', 'postgres', { label: 'writes' }) }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notes).toEqual([]);
    expect(r.doc.edges).toHaveLength(1);
    expect(r.doc.edges[0]).toMatchObject({ id: 'e1', label: 'writes' });
    expect(r.summary).toBe('updated');
  });
});

describe('removeGroup (spec §3.2)', () => {
  function nestedDoc(): GraphDoc {
    return doc({
      groups: [
        group('region-eu', { kind: 'region' }),
        group('vpc-private', { kind: 'vpc', parent: 'region-eu' }),
      ],
      nodes: [
        node('api-gateway', { parent: 'region-eu' }),
        node('postgres', { type: 'database', parent: 'vpc-private' }),
        node('web-client', { type: 'client' }),
      ],
      edges: [
        edge('e1', 'web-client', 'api-gateway'),
        edge('e2', 'api-gateway', 'postgres'),
      ],
    });
  }

  it('with reparentTo moves direct children instead of deleting them', () => {
    const r = applyPatch(
      nestedDoc(),
      patch([{ op: 'removeGroup', id: 'region-eu', reparentTo: null }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.groups.map((g) => g.id)).toEqual(['vpc-private']);
    expect(r.doc.groups[0]?.parent).toBeNull(); // direct child moved to root
    expect(r.doc.nodes.find((n) => n.id === 'api-gateway')?.parent).toBeNull();
    // grandchildren keep their (moved) parent
    expect(r.doc.nodes.find((n) => n.id === 'postgres')?.parent).toBe('vpc-private');
    expect(r.doc.edges).toHaveLength(2); // nothing else deleted
  });

  it('with reparentTo pointing at another group moves children into it', () => {
    const r = applyPatch(
      nestedDoc(),
      patch([{ op: 'removeGroup', id: 'vpc-private', reparentTo: 'region-eu' }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes.find((n) => n.id === 'postgres')?.parent).toBe('region-eu');
    expect(r.doc.edges).toHaveLength(2);
  });

  it('without reparentTo cascades: descendants and touching edges are deleted', () => {
    // Spec leaves this undefined; implemented as cascade delete of the group,
    // its descendants, and every edge touching a removed element.
    const r = applyPatch(nestedDoc(), patch([{ op: 'removeGroup', id: 'region-eu' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.groups).toEqual([]);
    expect(r.doc.nodes.map((n) => n.id)).toEqual(['web-client']);
    expect(r.doc.edges).toEqual([]); // e1 and e2 touched removed elements
  });

  it('removes the group from collapsed', () => {
    const d = nestedDoc();
    d.collapsed = ['vpc-private'];
    const r = applyPatch(d, patch([{ op: 'removeGroup', id: 'vpc-private', reparentTo: 'region-eu' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.collapsed).toEqual([]);
  });
});

describe('removeNode (rules text rule 10)', () => {
  it('does not cascade edges: removing a wired node alone is rejected by V5', () => {
    const r = applyPatch(baseDoc(), patch([{ op: 'removeNode', id: 'postgres' }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith('edge "e1" references unknown node "postgres".'))).toBe(
      true,
    );
  });

  it('removeNode plus removeEdge in one patch succeeds', () => {
    const r = applyPatch(
      baseDoc(),
      patch([
        { op: 'removeNode', id: 'postgres' },
        { op: 'removeEdge', id: 'e1' },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes.map((n) => n.id)).toEqual(['auth']);
    expect(r.doc.edges).toEqual([]);
    expect(r.summary).toBe('-1 node, -1 edge');
  });
});

// ---------------------------------------------------------------------------
// M6 audit fix — the §4.1 rejection shape for validation-pass errors.
//
// Per-op failures (thrown by applyOp) always carried `op N (kind):`. The V1–V13
// pass did not, so every cross-reference error — unknown endpoint, unknown
// parent, duplicate id — reached the agent with no op index, and in a ten-op
// patch it was told WHICH ID was wrong but not which op to edit. The spec's own
// example is one of these errors, with the prefix.
// ---------------------------------------------------------------------------

describe('validation errors are attributed to the op that caused them (spec §4.1)', () => {
  it('names the op index and kind for an unknown edge endpoint', () => {
    const r = applyPatch(
      baseDoc(),
      patch([
        { op: 'setTitle', title: 'Checkout' },
        { op: 'addNode', node: node('kafka', { type: 'queue' }) },
        { op: 'addEdge', edge: edge('e7', 'kafka', 'redis') },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      'op 2 (addEdge): edge "e7" references unknown node "redis".',
    ]);
  });

  it('names the op for an unknown parent', () => {
    const r = applyPatch(
      baseDoc(),
      patch([{ op: 'updateNode', id: 'auth', changes: { parent: 'no-such-vpc' } }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.startsWith('op 0 (updateNode): node "auth" has unknown parent')).toBe(
      true,
    );
  });

  it('leaves fallout from a REMOVAL unattributed rather than blaming the wrong op', () => {
    // removeNode "postgres" leaves edge e1 dangling. The error names the edge,
    // which this patch did not create — prefixing it with the removeNode would
    // point the agent at a line that is not the one to change.
    const r = applyPatch(baseDoc(), patch([{ op: 'removeNode', id: 'postgres' }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(['edge "e1" references unknown node "postgres".']);
  });
});

describe('summarise reports reparenting (spec §1.3 "group added, 2 moved")', () => {
  it('counts nodes that changed parent alongside the additions', () => {
    const r = applyPatch(
      baseDoc(),
      patch([
        { op: 'addGroup', group: group('vpc-private', { kind: 'vpc' }) },
        { op: 'updateNode', id: 'auth', changes: { parent: 'vpc-private' } },
        { op: 'updateNode', id: 'postgres', changes: { parent: 'vpc-private' } },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toBe('+1 group, 2 moved');
  });

  it('does not double-count a node that was added into a group', () => {
    const r = applyPatch(
      doc({ groups: [group('vpc')] }),
      patch([{ op: 'addNode', node: node('api', { parent: 'vpc' }) }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toBe('+1 node');
  });
});
