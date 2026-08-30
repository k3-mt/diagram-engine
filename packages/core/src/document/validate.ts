// document/validate.ts — invariants V1–V13 (spec §3.3; V11–V13 cover ERD mode,
// spec Part 13 item 2) plus V18–V19 (redundancy, spec §18.11).
//
// Run after every patch, before committing. Error strings are part of the
// contract: the agent reads them and self-corrects, so they must say what
// to do. V3 and V5 append the valid options — that one detail turns a
// two-turn correction into a one-turn one.

import type { GraphDoc } from '../schema/graph.js';
import { elementIds, isValidId, nearestId, slugify } from './ids.js';

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/** Label length bounds (spec §3.1): node/group label 1–40, note 1–60, edge label 1–24. */
const NODE_LABEL_MAX = 40;
const GROUP_LABEL_MAX = 40;
const NOTE_MAX = 60;
const EDGE_LABEL_MAX = 24;

/** Element budget (V8): nodes + groups + edges. */
const MAX_ELEMENTS = 200;

/** V1 message: `invalid id "Auth Service": use lowercase-hyphenated, e.g. "auth-service"` */
function invalidIdError(id: string): string {
  const suggestion = slugify(id) || 'my-id';
  return `invalid id "${id}": use lowercase-hyphenated, e.g. "${suggestion}"`;
}

/** V9 message: `label too long (54 chars, max 40): "..."` */
function labelTooLongError(label: string, max: number): string {
  const shown = label.length > 40 ? `${label.slice(0, 37)}...` : label;
  return `label too long (${label.length} chars, max ${max}): "${shown}"`;
}

/** V5 suffix: ` Did you mean "redis-cache"?` — empty string when nothing is close. */
function didYouMean(id: string, candidates: string[]): string {
  const near = nearestId(id, candidates);
  return near ? ` Did you mean "${near}"?` : '';
}

/** All descendant group/node containment: is `id` inside group `gid` (any depth)? */
function isDescendantOf(doc: GraphDoc, id: string, gid: string): boolean {
  const parentOf = new Map<string, string | null>();
  for (const n of doc.nodes) parentOf.set(n.id, n.parent);
  for (const g of doc.groups) parentOf.set(g.id, g.parent);
  let cur = parentOf.get(id) ?? null;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    if (cur === gid) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/**
 * The first (container, contained) pair among an alt set's targets, or null.
 *
 * Two ids that name a boundary and something inside it are not two
 * alternatives — see V18 below. Quadratic in the size of one alt set, which is
 * the number of replicas of one component: three or four in practice, and the
 * whole loop runs only over sets that already passed the distinct-id test.
 */
function nestedPair(doc: GraphDoc, targets: string[]): [string, string] | null {
  for (const outer of targets) {
    for (const inner of targets) {
      if (outer !== inner && isDescendantOf(doc, inner, outer)) return [outer, inner];
    }
  }
  return null;
}

/**
 * Validate a document against invariants V1–V13 (spec §3.3) and V18–V19
 * (spec §18.11).
 * Collects every violation; the exact message formats are the contract.
 */
export function validate(doc: GraphDoc): ValidationResult {
  const errors: string[] = [];
  const groupIds = doc.groups.map((g) => g.id);
  const groupIdSet = new Set(groupIds);
  const allIds = elementIds(doc);
  const allIdSet = new Set(allIds);
  const existingGroupsSuffix = ` Existing groups: ${groupIds.join(', ')}`;

  // V1 — IDs match the slug regex (nodes, groups, and edges all carry ids)
  for (const n of doc.nodes) if (!isValidId(n.id)) errors.push(invalidIdError(n.id));
  for (const g of doc.groups) if (!isValidId(g.id)) errors.push(invalidIdError(g.id));
  for (const e of doc.edges) if (!isValidId(e.id)) errors.push(invalidIdError(e.id));

  // V2 — no duplicate ID across nodes ∪ groups
  const seen = new Map<string, 'node' | 'group'>();
  for (const n of doc.nodes) {
    const prior = seen.get(n.id);
    if (prior) errors.push(`duplicate id "${n.id}": already exists as a ${prior}`);
    else seen.set(n.id, 'node');
  }
  for (const g of doc.groups) {
    const prior = seen.get(g.id);
    if (prior) errors.push(`duplicate id "${g.id}": already exists as a ${prior}`);
    else seen.set(g.id, 'group');
  }

  // V3 — parent refers to an existing group (nodes and groups alike)
  for (const n of doc.nodes) {
    if (n.parent !== null && !groupIdSet.has(n.parent)) {
      errors.push(
        `node "${n.id}" has unknown parent "${n.parent}".${existingGroupsSuffix}`,
      );
    }
  }
  for (const g of doc.groups) {
    if (g.parent !== null && !groupIdSet.has(g.parent)) {
      errors.push(
        `group "${g.id}" has unknown parent "${g.parent}".${existingGroupsSuffix}`,
      );
    }
  }

  // V4 — no cycle in the group parent chain
  const groupParent = new Map<string, string | null>();
  for (const g of doc.groups) groupParent.set(g.id, g.parent);
  const cycleReported = new Set<string>();
  for (const g of doc.groups) {
    if (cycleReported.has(g.id)) continue;
    const trail: string[] = [g.id];
    const onTrail = new Set<string>([g.id]);
    let cur = groupParent.get(g.id) ?? null;
    while (cur !== null && groupParent.has(cur)) {
      if (onTrail.has(cur)) {
        trail.push(cur);
        const start = trail.indexOf(cur);
        const cycle = trail.slice(start);
        for (const id of cycle) cycleReported.add(id);
        errors.push(`group cycle: ${cycle.join(' → ')}`);
        break;
      }
      trail.push(cur);
      onTrail.add(cur);
      cur = groupParent.get(cur) ?? null;
    }
  }

  // V5 — edge endpoints exist (node id OR group id), with "Did you mean ...?"
  for (const e of doc.edges) {
    for (const end of [e.from, e.to]) {
      if (!allIdSet.has(end)) {
        errors.push(
          `edge "${e.id}" references unknown node "${end}".${didYouMean(end, allIds)}`,
        );
      }
    }
  }

  // V6 — no self-edges
  for (const e of doc.edges) {
    if (e.from === e.to) {
      errors.push(`edge "${e.id}" connects "${e.from}" to itself`);
    }
  }

  // V7 — no duplicate edge (same from, to, label)
  const edgeKeys = new Set<string>();
  for (const e of doc.edges) {
    const key = `${e.from}\x00${e.to}\x00${e.label ?? ''}`;
    if (edgeKeys.has(key)) {
      const labelPart = e.label !== undefined ? ` "${e.label}"` : '';
      errors.push(`duplicate edge ${e.from} → ${e.to}${labelPart}`);
    } else {
      edgeKeys.add(key);
    }
  }

  // V8 — ≤ 200 elements
  const count = doc.nodes.length + doc.groups.length + doc.edges.length;
  if (count > MAX_ELEMENTS) {
    errors.push(`graph too large (${count}). Remove elements or split the diagram`);
  }

  // V9 — label lengths in bounds
  for (const n of doc.nodes) {
    if (n.label.length > NODE_LABEL_MAX) errors.push(labelTooLongError(n.label, NODE_LABEL_MAX));
    if (n.note !== undefined && n.note.length > NOTE_MAX) {
      errors.push(labelTooLongError(n.note, NOTE_MAX));
    }
  }
  for (const g of doc.groups) {
    if (g.label.length > GROUP_LABEL_MAX) errors.push(labelTooLongError(g.label, GROUP_LABEL_MAX));
  }
  for (const e of doc.edges) {
    if (e.label !== undefined && e.label.length > EDGE_LABEL_MAX) {
      errors.push(labelTooLongError(e.label, EDGE_LABEL_MAX));
    }
  }

  // V10 — no edge from a group to its own descendant
  for (const e of doc.edges) {
    if (groupIdSet.has(e.from) && isDescendantOf(doc, e.to, e.from)) {
      errors.push(`edge from "${e.from}" to its child "${e.to}"`);
    }
  }

  // ---------------------------------------------------------------------
  // ERD invariants (V11–V13). `meta` is deliberately NOT constrained by type:
  // it is general-purpose detail and belongs on any node. `fields` are
  // columns, so they only mean something on an entity. An entity with zero
  // fields is fine — the agent may add columns in a later turn.
  // ---------------------------------------------------------------------

  // V11 — no duplicate field name within one entity
  for (const n of doc.nodes) {
    if (n.fields === undefined) continue;
    const fieldSeen = new Set<string>();
    for (const f of n.fields) {
      if (fieldSeen.has(f.name)) {
        errors.push(
          `entity "${n.id}" has duplicate field "${f.name}": field names must be unique within an entity; rename or remove one`,
        );
      } else {
        fieldSeen.add(f.name);
      }
    }
  }

  // V12 — fields only on type "entity"
  for (const n of doc.nodes) {
    if (n.fields !== undefined && n.fields.length > 0 && n.type !== 'entity') {
      errors.push(
        `node "${n.id}" has fields but type is "${n.type}": use type "entity" for tables with columns`,
      );
    }
  }

  // V13 — cardinality needs at least one entity endpoint
  const entityIds = new Set(doc.nodes.filter((n) => n.type === 'entity').map((n) => n.id));
  for (const e of doc.edges) {
    if (e.cardinality === undefined) continue;
    // Unknown endpoints are already reported by V5; don't pile on.
    if (!allIdSet.has(e.from) || !allIdSet.has(e.to)) continue;
    if (!entityIds.has(e.from) && !entityIds.has(e.to)) {
      errors.push(
        `edge "${e.id}" has cardinality but neither "${e.from}" nor "${e.to}" is an entity: drop the cardinality or change an endpoint to type "entity"`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Redundancy invariants (V18–V19, spec §18.11). `alt` says two edges FROM
  // ONE SOURCE are alternatives, so both rules are about a set, not an edge:
  // a tag scoped per source, on synchronous edges only. Edges whose endpoints
  // are unknown are skipped — V5 already reports those, and two errors for one
  // mistake makes the agent fix the wrong thing (the V13 precedent).
  // ---------------------------------------------------------------------

  // Group the alt-carrying edges by (source, tag) in document order. DASHED
  // EDGES ARE NOT MEMBERS: the analysis builds its alt sets from synchronous
  // edges only (analysis/graph.ts), so counting a dashed edge here would let
  // V18 and the propagation disagree about what a set is — a solid+dashed pair
  // would pass V18 while behaving as a lone hard dependency, and the agent
  // would be told about the dashed tag (V19) and only on the NEXT round trip
  // about the meaningless one that remains. One validate, both corrections.
  const altSets = new Map<string, { tag: string; from: string; edges: typeof doc.edges }>();
  for (const e of doc.edges) {
    if (e.alt === undefined) continue;
    if (e.style === 'dashed') continue; // V19 reports it; it is not an alternative
    if (!allIdSet.has(e.from) || !allIdSet.has(e.to)) continue;
    const key = `${e.from}\x00${e.alt}`;
    const set = altSets.get(key);
    if (set) set.edges.push(e);
    else altSets.set(key, { tag: e.alt, from: e.from, edges: [e] });
  }

  // V18 — an alt tag needs at least two alternatives from the same source.
  // Two edges to the SAME target are not alternatives either: losing that
  // target takes both out, so the tag claims a redundancy the document does
  // not describe. Reported once per offending set, naming its first edge, so
  // a three-edge mistake is one correction and not three.
  for (const set of altSets.values()) {
    const first = set.edges[0]!;
    if (set.edges.length < 2) {
      errors.push(
        `edge "${first.id}" has alt "${set.tag}" but it is the only edge from "${set.from}" with that tag: alternatives need at least two`,
      );
      continue;
    }
    const targets = new Set(set.edges.map((e) => e.to));
    if (targets.size < 2) {
      errors.push(
        `edge "${first.id}" has alt "${set.tag}" but every edge from "${set.from}" with that tag points at "${first.to}": alternatives need at least two distinct targets`,
      );
      continue;
    }
    // Two distinct ids are still not two alternatives when one CONTAINS the
    // other: an edge naming a boundary is a dependency on what the boundary
    // holds (§3.1), so killing the inner node takes both edges out and killing
    // the group takes the inner node with it. Tagging an AZ and a database
    // inside that AZ is the likeliest hand-written version of this mistake,
    // and it is the same claim V18 exists to catch — a redundancy the document
    // does not describe. The propagation is already correct on such a document
    // (both edges fall in one wave and the source is at risk); what was
    // missing was the sentence saying the tag bought nothing.
    const nested = nestedPair(doc, [...targets]);
    if (nested !== null) {
      errors.push(
        `edge "${first.id}" has alt "${set.tag}" but "${nested[0]}" contains "${nested[1]}": one failure takes both out, so they are not alternatives`,
      );
    }
  }

  // V19 — alt requires a synchronous edge: an async path already stops
  // propagation (§18.3), so tagging one as an alternative claims a redundancy
  // that changes nothing.
  for (const e of doc.edges) {
    if (e.alt === undefined || e.style !== 'dashed') continue;
    if (!allIdSet.has(e.from) || !allIdSet.has(e.to)) continue;
    errors.push(
      `edge "${e.id}" is dashed and carries alt "${e.alt}": asynchronous edges already contain failure; drop one`,
    );
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
