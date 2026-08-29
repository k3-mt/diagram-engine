// document/apply.ts — atomic patch application (spec §3.4).
//
// Never partially apply. A rejected patch leaves the document untouched
// and returns the errors as the tool result; the agent reads them and
// fixes its own mistake on the next call.
//
// The §3.4 signature is extended minimally with a `notes` array carrying
// the ID-collision coercions from spec §3.5.

import type { GraphDoc } from '../schema/graph.js';
import type { GraphPatch, PatchOp } from '../schema/patch.js';
import { summarise } from '../format/summary.js';
import { coerceOp, nearestId } from './ids.js';
import { validate } from './validate.js';

export type ApplyResult =
  | { ok: true; doc: GraphDoc; summary: string; notes: string[] }
  | { ok: false; errors: string[] };

/** Terse unknown-id message for per-op failures, with a nearby suggestion. */
function unknownError(kind: 'node' | 'group' | 'edge', id: string, candidates: string[]): Error {
  const near = nearestId(id, candidates);
  const suffix = near ? ` Did you mean "${near}"?` : '';
  return new Error(`unknown ${kind} "${id}".${suffix}`);
}

/** Descendant ids (nodes and groups, any depth) of group `gid`. */
function descendantIds(doc: GraphDoc, gid: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of doc.nodes) {
      if (n.parent !== null && (n.parent === gid || out.has(n.parent)) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
    for (const g of doc.groups) {
      if (g.parent !== null && (g.parent === gid || out.has(g.parent)) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Apply one (already coerced) op to `next` in place.
 * Throws with a terse message on a per-op failure; the caller wraps it
 * as `op {i} ({op.op}): {message}`.
 */
function applyOp(next: GraphDoc, op: PatchOp): void {
  switch (op.op) {
    case 'addNode': {
      next.nodes.push(op.node);
      return;
    }
    case 'updateNode': {
      const node = next.nodes.find((n) => n.id === op.id);
      if (!node) throw unknownError('node', op.id, next.nodes.map((n) => n.id));
      Object.assign(node, op.changes);
      return;
    }
    case 'removeNode': {
      const i = next.nodes.findIndex((n) => n.id === op.id);
      if (i < 0) throw unknownError('node', op.id, next.nodes.map((n) => n.id));
      next.nodes.splice(i, 1);
      return;
    }
    case 'addGroup': {
      next.groups.push(op.group);
      return;
    }
    case 'updateGroup': {
      const group = next.groups.find((g) => g.id === op.id);
      if (!group) throw unknownError('group', op.id, next.groups.map((g) => g.id));
      Object.assign(group, op.changes);
      return;
    }
    case 'removeGroup': {
      const i = next.groups.findIndex((g) => g.id === op.id);
      if (i < 0) throw unknownError('group', op.id, next.groups.map((g) => g.id));
      next.groups.splice(i, 1);
      if (op.reparentTo !== undefined) {
        // move direct children instead of deleting them — "flatten the vpc"
        const target = op.reparentTo;
        for (const n of next.nodes) if (n.parent === op.id) n.parent = target;
        for (const g of next.groups) if (g.parent === op.id) g.parent = target;
      } else {
        // no reparent target: the group's descendants go with it,
        // along with every edge touching a removed element
        const gone = descendantIds(next, op.id);
        gone.add(op.id);
        next.nodes = next.nodes.filter((n) => !gone.has(n.id));
        next.groups = next.groups.filter((g) => !gone.has(g.id));
        next.edges = next.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
      }
      // collapsed may reference the removed group
      next.collapsed = next.collapsed.filter((c) => c !== op.id);
      return;
    }
    case 'addEdge': {
      const existing = next.edges.find((e) => e.id === op.edge.id);
      if (existing) {
        // same endpoints (different endpoints were re-id'd by coercion):
        // "this edge, with these properties"
        Object.assign(existing, op.edge);
        return;
      }
      next.edges.push(op.edge);
      return;
    }
    case 'updateEdge': {
      const edge = next.edges.find((e) => e.id === op.id);
      if (!edge) throw unknownError('edge', op.id, next.edges.map((e) => e.id));
      Object.assign(edge, op.changes);
      return;
    }
    case 'removeEdge': {
      const i = next.edges.findIndex((e) => e.id === op.id);
      if (i < 0) throw unknownError('edge', op.id, next.edges.map((e) => e.id));
      next.edges.splice(i, 1);
      return;
    }
    case 'setTitle': {
      next.title = op.title;
      return;
    }
    case 'setDirection': {
      next.direction = op.direction;
      return;
    }
  }
}

/**
 * Apply a patch atomically (spec §3.4).
 *
 * Clones the document, applies every op (collecting per-op errors as
 * `op {i} ({op.op}): {message}`), validates the result against V1–V10,
 * and only then returns the new document. Any failure returns the full
 * error list and leaves the input document untouched.
 *
 * ID collisions are coerced per spec §3.5 and reported in `notes`.
 */
export function applyPatch(doc: GraphDoc, patch: GraphPatch): ApplyResult {
  const next = structuredClone(doc);
  const errors: string[] = [];
  const notes: string[] = [];

  for (const [i, op] of patch.ops.entries()) {
    const coerced = coerceOp(next, op);
    if (coerced.note) notes.push(coerced.note);
    try {
      applyOp(next, coerced.op);
    } catch (e) {
      errors.push(`op ${i} (${op.op}): ${(e as Error).message}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const v = validate(next);
  if (!v.ok) return { ok: false, errors: v.errors };

  return { ok: true, doc: next, summary: summarise(doc, next), notes };
}
