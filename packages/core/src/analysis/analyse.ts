// analysis/analyse.ts — the six signals, assembled into one result (spec §15).
//
// analyse(doc) is the whole of Part 15's computation. It returns STRUCTURED
// DATA, never formatted text: `diagram analyse`, the MCP twin and the viewer's
// analysis view mode all read this same object, and three consumers formatting
// three ways from one set of numbers is the only arrangement in which the CLI
// and MCP can be asserted byte-identical.
//
// The honesty contract (§15.3) is encoded rather than documented:
//
//   A1  Nothing here writes. The result shares no array with the input.
//   A2  The only parameter is the FULL document. There is no overload taking a
//       derived view, so a caller cannot analyse the `exec` picture by
//       accident and be told the collapsed VPC has fan-in 1.
//   A3  Every number in this result is STRUCTURAL and therefore asserted. Not
//       one operational claim is made — `coverage.keys` names the meta keys
//       that exist, so a surface that wants to state "rps=12000" has to
//       attribute it to the key it came from, and an agent that wants to
//       guess has nothing here to hide behind.
//   A4  Exclusions travel WITH the result and are never empty-by-omission.
//   A5  Coverage travels with the result for the same reason. Both are on the
//       type, so a surface that forgets to print them is visibly incomplete
//       rather than quietly wrong.

import {
  byDocumentOrder,
  hasExclusions,
  labelOf,
  operationalMetaKeys,
  runtimeGraph,
  type Coverage,
  type Exclusions,
  type RuntimeGraph,
} from './graph.js';
import {
  articulationPoints,
  boundaryCrossings,
  fanIn,
  fanOut,
  longestSyncChain,
  sharedDependency,
  syncCycles,
  type ArticulationPoint,
  type BoundaryCrossing,
  type FanCounts,
  type SyncChain,
  type SyncCycle,
} from './signals.js';
import type { GraphDoc, NodeType } from '../schema/graph.js';

/** Every structural signal, for one node. */
export type NodeSignals = {
  id: string;
  label: string;
  type: NodeType;
  fanIn: FanCounts;
  fanOut: FanCounts;
  /** how many entry points can reach it — the "everyone's outage" number */
  sharedDependency: number;
  /** those entry points, in document order */
  reachedBy: string[];
  /** true when nothing points at it (spec §15.2; NOT the same as type client) */
  isEntryPoint: boolean;
  /** its articulation-point finding, or null. Never conflated with blast radius */
  articulation: ArticulationPoint | null;
  /** A5, per node: the operational meta keys it carries, sorted */
  metaKeys: string[];
};

/**
 * Minimum synchronous fan-in at which a node is listed as a chokepoint.
 *
 * Exported because the surface must not invent a second threshold: two
 * different "is this a chokepoint" rules in one product is how the CLI and the
 * viewer start disagreeing about which box to ring.
 */
export const CHOKEPOINT_MIN_SYNC_FAN_IN = 2;

/** Minimum number of entry points reaching a node for it to be a chokepoint. */
export const CHOKEPOINT_MIN_SHARED_DEPENDENCY = 2;

/**
 * Is this node worth naming as a chokepoint?
 *
 * An articulation point always is. Otherwise it needs real CONVERGENCE: two or
 * more synchronous callers, or two or more inbound edges carrying the traffic
 * of two or more entry points. Shared dependency alone is not enough — in a
 * small graph with two clients, nearly every node is reachable from both, and
 * a "chokepoints" block that lists the whole diagram says nothing at all.
 */
export function isChokepoint(s: NodeSignals): boolean {
  if (s.isEntryPoint) return false;
  if (s.articulation !== null) return true;
  if (s.fanIn.sync >= CHOKEPOINT_MIN_SYNC_FAN_IN) return true;
  return s.fanIn.total >= 2 && s.sharedDependency >= CHOKEPOINT_MIN_SHARED_DEPENDENCY;
}

/** The whole of §15's output, as data. */
export type Analysis = {
  title: string;
  /**
   * A2, stated on the result: this was computed over the full document. It is
   * a literal type with one member, so it cannot be set to anything else and a
   * surface can print it as a guarantee rather than a hope.
   */
  scope: 'document';
  /** every runtime node, in document order */
  nodes: NodeSignals[];
  /** nodes with no inbound edge, in document order */
  entryPoints: string[];
  /** the nodes worth naming, ranked most pressured first */
  chokepoints: NodeSignals[];
  /** undirected single points of failure, in document order */
  articulationPoints: ArticulationPoint[];
  /** the longest run of synchronous calls, or null if there is none */
  longestSyncChain: SyncChain | null;
  /** SCCs over synchronous edges, size > 1 */
  syncCycles: SyncCycle[];
  /** edges that leave their container, per container pair */
  boundaryCrossings: BoundaryCrossing[];
  /** A5 — always present */
  coverage: Coverage;
  /** A4 — always present */
  excluded: Exclusions;
  /**
   * The sentences a surface MUST be able to print verbatim: what was left out
   * and what is not known. Built here so the CLI, the MCP tool and the viewer
   * cannot each phrase the blind spots their own way (or omit them).
   */
  notes: string[];
};

/** Ranking for the chokepoint list: most convergent pressure first. */
function chokepointRank(a: NodeSignals, b: NodeSignals): number {
  const art = (s: NodeSignals) => (s.articulation === null ? 0 : 1);
  const isolates = (s: NodeSignals) => s.articulation?.isolates ?? 0;
  return (
    b.fanIn.sync - a.fanIn.sync ||
    art(b) - art(a) ||
    isolates(b) - isolates(a) ||
    b.sharedDependency - a.sharedDependency ||
    b.fanIn.total - a.fanIn.total
  );
}

/** `n thing` / `n things`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The closing sentence of an analysis: what structure alone cannot know (A3). */
export const NOTE_STRUCTURAL_ONLY =
  'structural facts only: no traffic, latency or capacity is known to the document';

/**
 * The A4/A5 sentences, in the order §15.4 prints them. One place, so "2 entity
 * nodes excluded (data model, not runtime)" reads identically wherever it
 * appears — including in Part 18's assumptions block, which is built from this
 * same list rather than from a second, drifting copy of the wording.
 */
export function blindSpotNotes(coverage: Coverage, excluded: Exclusions): string[] {
  const notes: string[] = [];
  notes.push(
    coverage.nodes === 0
      ? 'no runtime nodes to analyse'
      : `${coverage.withoutMeta} of ${coverage.nodes} nodes carry no operational meta`,
  );
  if (excluded.entityNodes.length > 0) {
    notes.push(
      `${count(excluded.entityNodes.length, 'entity node')} excluded (data model, not runtime)`,
    );
  }
  if (excluded.cardinalityEdges.length > 0) {
    notes.push(
      `${count(excluded.cardinalityEdges.length, 'cardinality edge')} excluded (relationship, not a call)`,
    );
  }
  if (excluded.entityEdges.length > 0) {
    notes.push(
      `${count(excluded.entityEdges.length, 'edge')} excluded for touching an entity node`,
    );
  }
  if (excluded.danglingEdges.length > 0) {
    notes.push(
      `${count(excluded.danglingEdges.length, 'edge')} excluded for naming an unknown endpoint`,
    );
  }
  if (excluded.erdOnly) {
    notes.push('this document is a data model, not a runtime: there is nothing to analyse');
  }
  return notes;
}

/** blindSpotNotes plus A3's closing sentence — what `analyse` prints. */
export function analysisNotes(coverage: Coverage, excluded: Exclusions): string[] {
  return [...blindSpotNotes(coverage, excluded), NOTE_STRUCTURAL_ONLY];
}

/** Per-node signals over an already-built projection (shared with Part 18). */
export function nodeSignals(g: RuntimeGraph): NodeSignals[] {
  const reached = sharedDependency(g);
  const articulation = new Map<string, ArticulationPoint>(
    articulationPoints(g).map((a) => [a.id, a]),
  );
  const entries = new Set(g.entryPoints);

  return g.nodeIds.map((id) => {
    const node = g.nodeById.get(id);
    const reachedBy = reached.get(id) ?? [];
    return {
      id,
      label: labelOf(g, id),
      type: node?.type ?? 'service',
      fanIn: fanIn(g, id),
      fanOut: fanOut(g, id),
      sharedDependency: reachedBy.length,
      reachedBy,
      isEntryPoint: entries.has(id),
      articulation: articulation.get(id) ?? null,
      // operationalMetaKeys, not Object.keys: coverage is built through it and
      // one Analysis must not carry two answers to "what operational meta does
      // this node have". The reserved `collapsed` marker is deriveView's, and a
      // collapsed box must not be able to claim it is documented.
      metaKeys: node === undefined ? [] : operationalMetaKeys(node).sort(),
    };
  });
}

/**
 * The six signals over the FULL document (§15.2), with coverage and
 * exclusions attached (§15.3 A4, A5).
 *
 * Pure and total. It never mutates `doc`, never throws, and gives a document
 * that failed validation the most honest answer it can rather than none.
 */
export function analyse(doc: GraphDoc): Analysis {
  const g = runtimeGraph(doc);
  const signals = nodeSignals(g);

  return {
    title: doc.title,
    scope: 'document',
    nodes: signals,
    entryPoints: byDocumentOrder(g, g.entryPoints),
    chokepoints: signals.filter(isChokepoint).sort(chokepointRank),
    articulationPoints: signals
      .map((s) => s.articulation)
      .filter((a): a is ArticulationPoint => a !== null),
    longestSyncChain: longestSyncChain(g),
    syncCycles: syncCycles(g),
    boundaryCrossings: boundaryCrossings(g),
    coverage: g.coverage,
    excluded: g.excluded,
    notes: analysisNotes(g.coverage, g.excluded),
  };
}

/**
 * True when there ARE synchronous calls but no chain to report, because the
 * whole synchronous subgraph condenses to one strongly connected component.
 *
 * The `sync chains` block would otherwise just be missing, and "no chain" and
 * "the chain is a loop" are different findings — the second is the shape that
 * accumulates the most synchronous latency of any. The surface says which.
 */
export function analysisIsChainlessCycle(a: Analysis): boolean {
  return a.longestSyncChain === null && a.syncCycles.length > 0;
}

/** True when `analyse` left something out — the surface must then say so. */
export function analysisIsPartial(a: Analysis): boolean {
  return hasExclusions(a.excluded) || a.coverage.withoutMeta > 0;
}
