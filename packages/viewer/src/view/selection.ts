// view/selection.ts — what one selected node is CONNECTED to (spec §8.7).
//
// A pure read of the drawn document: given a node id, which edges touch it,
// which way each one runs, and what is at the other end. No React, no
// geometry, no state — the panel renders this, the canvas overlay lights up
// the ids in it, and both are looking at the same answer.
//
// THIS IS INSPECTION, NOT ANALYSIS. It reports the edges the document holds,
// exactly as authored, one hop out. It deliberately does NOT reason about
// what would fail, traverse further, weigh anything, or skip asynchronous
// edges — that is `analyse` and `blastRadius`, they run on the FULL document
// (A2), and their answers are predictions. This one is a fact about the
// picture on screen, so it runs on the DERIVED document the reader is
// looking at: click a collapsed group's stand-in and you get the edges drawn
// into and out of that stand-in, which are the lines actually lighting up.
//
// TWO DOCUMENTS, DELIBERATELY. deriveView merges every edge that shares a
// (from, to) pair into ONE drawn line — that happens with nothing collapsed
// at all, so `orders --reads--> postgres` and `orders --writes--> postgres`
// are one grey `×2` line on the canvas, and their kinds are dropped because
// they disagree. The canvas is right to draw one line there; a panel that
// listed one row would be wrong, because the reader clicked to be told
// EVERYTHING about this node and one of its two relationships would be
// missing. So the geometry side of this answer comes from the DERIVED
// document (which line lights up, which box the row selects) and the content
// side comes from the SOURCE (which relationships actually exist, with their
// kinds and payloads intact). Given no source, it reports the derived
// document alone — which is exactly what it did before.
//
// Nothing here writes (§1.6): selection is a lens over one tab.

import type { GEdge, GNode, GraphDoc } from '@diagram-engine/core';
import type { MergedEdgeSources } from '../../../core/src/view/derive.js';

/** One edge touching the selected node, read from the node's point of view. */
export interface Connection {
  /**
   * The edge as AUTHORED, with its kind, payload and step intact — from the
   * source document when there is one, so a merged pair reports two rows
   * rather than one summary.
   */
  edge: GEdge;
  /**
   * id of the line this row is DRAWN as, which is what the overlay lights up
   * and may stand for several authored edges. Equal to `edge.id` whenever
   * nothing was merged.
   */
  drawnId: string;
  /**
   * 'out' — the selected node is this edge's `from`: it calls, reads or
   *         publishes, and DEPENDS on the far end.
   * 'in'  — the selected node is this edge's `to`: something else depends
   *         on it.
   */
  direction: 'out' | 'in';
  /** id at the far end. May name a group: §3.1 lets an edge point at one. */
  otherId: string;
  /** The far end's label, or its bare id when nothing in the document has it. */
  otherLabel: string;
  /** True when the far end is a group rather than a node. */
  otherIsGroup: boolean;
  /**
   * Where the edge REALLY lands, when a collapse has moved it: the label of
   * the authored far end, present only when that differs from the drawn one.
   *
   * Without it a collapsed vpc reports three identical "calls Private VPC"
   * rows and the reader cannot tell them apart; with it they read "calls
   * Private VPC (Orders)". Clicking still selects the drawn box, because the
   * authored one is not on the canvas to select.
   */
  insideLabel?: string;
}

/** Everything the panel and the canvas overlay need about one selection. */
export interface SelectionView {
  node: GNode;
  /** Edges leaving the node, in document order. */
  outgoing: Connection[];
  /** Edges arriving at the node, in document order. */
  incoming: Connection[];
  /** ids of every edge in either list — what the overlay draws. */
  edgeIds: Set<string>;
  /** ids at the far ends, plus the node itself — what stays undimmed. */
  nodeIds: Set<string>;
}

/**
 * Read the connections of `id` out of `doc`, or null when the document has
 * no node with that id.
 *
 * Null rather than an empty view is the point: a selected node that a
 * document update has REMOVED must close the panel, not show an existing box
 * with nothing attached to it. main.tsx resolves the selection against the
 * current frame on every render for exactly that reason.
 *
 * A self-edge cannot occur (V6 forbids it), but if one somehow reaches the
 * viewer it is reported as outgoing only — listing it twice would double it
 * in the count and light nothing extra up.
 */
export interface SelectionSource {
  /** The full document `doc` was derived from. */
  source: GraphDoc;
  /** deriveView's map from each drawn edge to the edges it stands for. */
  merges: readonly MergedEdgeSources[];
}

export function selectionView(
  doc: GraphDoc,
  id: string,
  from?: SelectionSource,
): SelectionView | null {
  const node = doc.nodes.find((n) => n.id === id);
  if (node === undefined) return null;

  // Labels come from BOTH documents: the drawn one names the box a row
  // selects, the source one names what an edge really reaches inside a
  // collapsed group. The drawn document wins on a clash, since it is the
  // picture the reader is pointing at.
  const labels = new Map<string, { label: string; isGroup: boolean }>();
  const learn = (d: GraphDoc): void => {
    for (const n of d.nodes) labels.set(n.id, { label: n.label, isGroup: false });
    for (const g of d.groups) labels.set(g.id, { label: g.label, isGroup: true });
  };
  if (from !== undefined) learn(from.source);
  learn(doc);

  // Drawn edge id -> the authored edges behind it. Absent for a document
  // handed over with no source, which is the pre-§8.7 behaviour intact.
  const authored = new Map<string, GEdge[]>();
  if (from !== undefined) {
    const byId = new Map(from.source.edges.map((e) => [e.id, e]));
    for (const { id: drawn, sources } of from.merges) {
      const found = sources.flatMap((sid) => {
        const e = byId.get(sid);
        return e === undefined ? [] : [e];
      });
      if (found.length > 0) authored.set(drawn, found);
    }
  }

  const outgoing: Connection[] = [];
  const incoming: Connection[] = [];
  const edgeIds = new Set<string>();
  const nodeIds = new Set<string>([id]);

  const connect = (
    drawn: GEdge,
    direction: 'out' | 'in',
    otherId: string,
  ): Connection[] => {
    const found = labels.get(otherId);
    edgeIds.add(drawn.id);
    nodeIds.add(otherId);
    // The bare id is the honest fallback: an edge may name an element the
    // derived view has hidden, and inventing a label for it would be worse
    // than showing the id the document actually holds.
    const base = {
      drawnId: drawn.id,
      direction,
      otherId,
      otherLabel: found?.label ?? otherId,
      otherIsGroup: found?.isGroup ?? false,
    };
    const behind = authored.get(drawn.id) ?? [drawn];
    return behind.map((edge) => {
      // Which end of the AUTHORED edge is the far one? Not necessarily the
      // same id as the drawn far end — that is the whole point of the merge.
      const realOther = direction === 'out' ? edge.to : edge.from;
      const inside =
        realOther === otherId ? undefined : (labels.get(realOther)?.label ?? realOther);
      return inside === undefined
        ? { ...base, edge }
        : { ...base, edge, insideLabel: inside };
    });
  };

  for (const edge of doc.edges) {
    if (edge.from === id) outgoing.push(...connect(edge, 'out', edge.to));
    else if (edge.to === id) incoming.push(...connect(edge, 'in', edge.from));
  }

  return { node, outgoing, incoming, edgeIds, nodeIds };
}
