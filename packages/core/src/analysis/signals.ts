// analysis/signals.ts — the six structural signals (spec §15.2).
//
// Fan-in/out, shared dependency, articulation points, longest synchronous
// chain, boundary crossings, synchronous cycles. All pure functions over the
// runtime projection, all sub-millisecond at the 200-element cap (V8), all
// testable with nothing running — exactly like deriveView.
//
// The spec's implementation notes are followed literally, and they are the
// unusual half of this file:
//
//   * ARTICULATION POINTS use the naive algorithm on purpose. Remove each
//     vertex in turn, count connected components of the undirected
//     projection, compare with the baseline. O(n·(n+e)) is nothing at 200
//     elements and it is very hard to get wrong; Tarjan's low-point algorithm
//     is the opposite trade, and a subtly wrong single-point-of-failure list
//     is worse than a slow one.
//
//   * LONGEST SYNC CHAIN condenses strongly connected components FIRST. The
//     longest path is NP-hard on a general graph and linear on a DAG, and a
//     cycle is a finding in its own right (it is signal six), never something
//     to traverse silently. So a cycle contributes ONE step to a chain, and
//     the chain says it passed through one.
//
// Nothing here reads doc.collapsed or calls deriveView (A2), and nothing here
// writes (A1).

import {
  byDocumentOrder,
  documentRank,
  labelOf,
  participatingAncestors,
  type RuntimeEdge,
  type RuntimeGraph,
} from './graph.js';

// ---------------------------------------------------------------------------
// 1. fan-in / fan-out
// ---------------------------------------------------------------------------

/** Edge counts split the way §15.2 asks for: total, and synchronous vs not. */
export type FanCounts = { total: number; sync: number; async: number };

function fan(edges: readonly RuntimeEdge[]): FanCounts {
  const sync = edges.filter((e) => e.sync).length;
  return { total: edges.length, sync, async: edges.length - sync };
}

/** Inbound edge counts for `id`. */
export function fanIn(g: RuntimeGraph, id: string): FanCounts {
  return fan(g.in.get(id) ?? []);
}

/** Outbound edge counts for `id`. */
export function fanOut(g: RuntimeGraph, id: string): FanCounts {
  return fan(g.out.get(id) ?? []);
}

// ---------------------------------------------------------------------------
// 2. shared dependency
// ---------------------------------------------------------------------------

/**
 * For every vertex, the entry points that can reach it — forward reachability
 * from each entry point over ALL included edges, synchronous or not.
 *
 * Two decisions:
 *   * Async edges COUNT here. "Everyone depends on this" is a statement about
 *     the dependency graph, not about failure propagation; a queue consumer
 *     still depends on the queue. Failure propagation is Part 18's job and it
 *     uses sync edges only — the two must not be conflated.
 *   * Reachability is STRICT (paths of length ≥ 1), so an entry point does not
 *     count itself. An entry point appears in its own set only when a cycle
 *     genuinely leads back to it, which is a real finding.
 */
export function sharedDependency(g: RuntimeGraph): Map<string, string[]> {
  const reachedBy = new Map<string, Set<string>>(g.vertices.map((v) => [v, new Set()]));
  for (const entry of g.entryPoints) {
    const seen = new Set<string>();
    const queue: string[] = [entry];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const e of g.out.get(cur) ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        reachedBy.get(e.to)?.add(entry);
        queue.push(e.to);
      }
    }
  }
  const out = new Map<string, string[]>();
  for (const [id, set] of reachedBy) out.set(id, byDocumentOrder(g, set));
  return out;
}

// ---------------------------------------------------------------------------
// 3. articulation points
// ---------------------------------------------------------------------------

/**
 * A single point of failure in the UNDIRECTED sense: remove it and the graph
 * falls apart. Never to be conflated with blast radius (§18.3) — that is
 * directed dependency propagation. They usually agree; where they differ, the
 * difference is the interesting part, which is why both are computed and
 * reported side by side and neither is derived from the other.
 */
export type ArticulationPoint = {
  id: string;
  label: string;
  /** how many pieces its own component breaks into once it is removed (≥ 2) */
  components: number;
  /**
   * How many NODES are cut off from the largest surviving piece.
   *
   * Nodes only. A group is a vertex of the projection when an edge names it
   * (spec §3.1), and counting a boundary as a node would print "isolates 1
   * node" for an experiment that isolates no component at all. §18.3's third
   * detail is entirely about not letting two vocabularies merge, so the
   * boundaries get their own field and their own noun.
   */
  isolates: number;
  /** those nodes, in document order */
  isolated: string[];
  /** boundaries cut off from the largest surviving piece, in document order */
  isolatedBoundaries: string[];
};

/**
 * Undirected adjacency over the included edges (direction discarded), PLUS
 * containment: every vertex is adjacent to each participating group that
 * contains it.
 *
 * Containment is real connectivity. An edge `web → vpc` with `api` and `db`
 * inside the VPC genuinely links the two halves of that document; without the
 * containment link the projection falls into two disconnected pieces and every
 * cut vertex between them disappears — an under-report of single points of
 * failure, which is the dangerous direction. Only PARTICIPATING groups (ones
 * an edge names) are vertices at all, so a document whose edges never touch a
 * group is completely unaffected.
 */
function undirected(g: RuntimeGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>(g.vertices.map((v) => [v, []]));
  for (const e of g.edges) {
    if (e.from === e.to) continue; // a self-loop changes no connectivity
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  for (const v of g.vertices) {
    for (const gid of participatingAncestors(g, v)) {
      adj.get(v)?.push(gid);
      adj.get(gid)?.push(v);
    }
  }
  return adj;
}

/** The connected component containing `start`, minus `removed`. */
function componentFrom(
  adj: Map<string, string[]>,
  start: string,
  removed: string | null,
): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const next of adj.get(cur) ?? []) {
      if (next === removed || seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

/**
 * Every articulation point among the runtime NODES, in document order.
 *
 * Groups are vertices of the projection (an edge may point at one) but are
 * never reported as articulation points: a group is a boundary, and "remove
 * the VPC" is Part 18's group experiment, not a single point of failure.
 */
export function articulationPoints(g: RuntimeGraph): ArticulationPoint[] {
  const adj = undirected(g);
  const found: ArticulationPoint[] = [];

  for (const id of g.nodeIds) {
    const neighbours = adj.get(id) ?? [];
    if (neighbours.length < 2) continue; // a leaf can never disconnect anything

    // Only this vertex's own component can split, so only it is walked.
    const home = componentFrom(adj, id, null);
    const pieces: Set<string>[] = [];
    const placed = new Set<string>([id]);
    for (const v of byDocumentOrder(g, home)) {
      if (placed.has(v)) continue;
      const piece = componentFrom(adj, v, id);
      for (const m of piece) placed.add(m);
      pieces.push(piece);
    }
    if (pieces.length < 2) continue;

    // The largest surviving piece is "the system"; everything else is cut off.
    // Ties resolve to the first piece in document order, which is why `pieces`
    // was built by walking the component in document order — the answer must
    // not depend on Set iteration luck.
    let largest = 0;
    for (let i = 1; i < pieces.length; i += 1) {
      if ((pieces[i]?.size ?? 0) > (pieces[largest]?.size ?? 0)) largest = i;
    }
    const isolated: string[] = [];
    pieces.forEach((piece, i) => {
      if (i !== largest) isolated.push(...piece);
    });

    const isolatedNodes = isolated.filter((v) => g.nodeById.has(v));
    const isolatedGroups = isolated.filter((v) => g.groupById.has(v));
    found.push({
      id,
      label: labelOf(g, id),
      components: pieces.length,
      isolates: isolatedNodes.length,
      isolated: byDocumentOrder(g, isolatedNodes),
      isolatedBoundaries: byDocumentOrder(g, isolatedGroups),
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// 4 & 6. synchronous cycles, and the longest synchronous chain
// ---------------------------------------------------------------------------

/** A strongly connected component of the synchronous subgraph, size ≥ 2. */
export type SyncCycle = {
  /** members in DOCUMENT order (≥ 2) — a set, not a path. See `loop`. */
  members: string[];
  /**
   * A REAL closed walk through the component: the shortest simple directed
   * cycle through `members[0]`, as vertices, not repeating the start.
   *
   * This field exists because `members` is document order and nothing about
   * document order is a traversal order. A surface that joined `members` with
   * `→` would print arrows that are not edges — and for a three-member
   * component whose document order runs against the loop, every arrow printed
   * is the exact reverse of a real one. Direction is the single quantity
   * §18.10 gate 2 was written to protect, so the only ordered list this type
   * offers is one every consecutive pair of which is an actual synchronous
   * edge.
   *
   * `loop.length` may be SHORTER than `members.length`: a strongly connected
   * component need not be a simple ring (a two-cycle hanging off a larger
   * loop is still one component), and no single simple cycle need cover it.
   * The surface must say so rather than printing the loop as if it were the
   * whole component.
   */
  loop: string[];
  /** the synchronous edge ids inside the cycle, in document order */
  edges: string[];
};

/**
 * The longest path over synchronous edges, measured in steps of the condensed
 * graph. A strongly connected component counts as ONE step and is named by its
 * first member; `cycles` says which steps were cycles, so the surface can
 * never print a cycle as if it were a straight line.
 */
export type SyncChain = {
  /** the chain, one id per condensed step, in dependency order (caller → callee) */
  path: string[];
  /** path.length — the "depth 4" of §15.4 */
  depth: number;
  /** the synchronous edge ids the chain traverses between steps */
  edges: string[];
  /** true when a step of the path is a cycle rather than a single node */
  throughCycle: boolean;
  /** the cycles on the path, if any */
  cycles: SyncCycle[];
};

type Condensation = {
  /** component index per vertex */
  compOf: Map<string, number>;
  /** members of each component, in document order */
  members: string[][];
};

/**
 * Kosaraju over the synchronous subgraph, written iteratively.
 *
 * Iterative rather than recursive is not premature caution: a 200-element
 * document is allowed to be a 200-long chain, and analysis must never be the
 * thing that throws a RangeError at the agent mid-turn.
 */
function condenseSync(g: RuntimeGraph): Condensation {
  const outSync = new Map<string, string[]>(g.vertices.map((v) => [v, []]));
  const inSync = new Map<string, string[]>(g.vertices.map((v) => [v, []]));
  for (const e of g.edges) {
    if (!e.sync) continue;
    outSync.get(e.from)?.push(e.to);
    inSync.get(e.to)?.push(e.from);
  }

  // pass 1: finish order
  const finished: string[] = [];
  const visited = new Set<string>();
  for (const start of g.vertices) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: { v: string; i: number }[] = [{ v: start, i: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { v: string; i: number };
      const next = (outSync.get(frame.v) ?? [])[frame.i];
      frame.i += 1;
      if (next === undefined) {
        finished.push(frame.v);
        stack.pop();
        continue;
      }
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push({ v: next, i: 0 });
    }
  }

  // pass 2: reverse graph, in reverse finish order
  const compOf = new Map<string, number>();
  const members: string[][] = [];
  for (let i = finished.length - 1; i >= 0; i -= 1) {
    const start = finished[i] as string;
    if (compOf.has(start)) continue;
    const idx = members.length;
    const group: string[] = [];
    const stack = [start];
    compOf.set(start, idx);
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      group.push(cur);
      for (const prev of inSync.get(cur) ?? []) {
        if (compOf.has(prev)) continue;
        compOf.set(prev, idx);
        stack.push(prev);
      }
    }
    members.push(byDocumentOrder(g, group));
  }
  return { compOf, members };
}

/** Synchronous edges whose endpoints are both in `members`. */
function internalSyncEdges(g: RuntimeGraph, members: readonly string[]): string[] {
  const set = new Set(members);
  return g.edges.filter((e) => e.sync && set.has(e.from) && set.has(e.to)).map((e) => e.id);
}

/**
 * The shortest simple directed cycle through `members[0]`, over the
 * component's own synchronous edges.
 *
 * Breadth-first, so the result is the shortest such cycle, and neighbours are
 * walked in document order, so it is the same cycle every run. A strongly
 * connected component of size ≥ 2 always has one, and the fallback to
 * `members` can therefore only be reached by a caller passing something that
 * is not an SCC — it is a guard, not a path this package takes.
 */
function cycleLoop(g: RuntimeGraph, members: readonly string[]): string[] {
  const set = new Set(members);
  const start = members[0];
  if (start === undefined) return [];

  const succ = new Map<string, string[]>(members.map((m) => [m, []]));
  for (const e of g.edges) {
    if (!e.sync || e.from === e.to) continue;
    if (!set.has(e.from) || !set.has(e.to)) continue;
    succ.get(e.from)?.push(e.to);
  }
  for (const [, list] of succ) list.sort((a, b) => documentRank(g, a) - documentRank(g, b));

  const prev = new Map<string, string>();
  const seen = new Set<string>([start]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const to of succ.get(cur) ?? []) {
        if (to === start) {
          // Closed. Walk `prev` back to the start to recover the cycle.
          const path = [cur];
          let step = cur;
          while (step !== start) {
            const p = prev.get(step);
            if (p === undefined) break;
            path.unshift(p);
            step = p;
          }
          return path;
        }
        if (seen.has(to)) continue;
        seen.add(to);
        prev.set(to, cur);
        next.push(to);
      }
    }
    frontier = next;
  }
  return [...members];
}

/**
 * Signal 6: strongly connected components over synchronous edges, size > 1 —
 * cascading-failure and distributed-deadlock risk, in document order.
 */
export function syncCycles(g: RuntimeGraph): SyncCycle[] {
  const { members } = condenseSync(g);
  return members
    .filter((m) => m.length > 1)
    .map((m) => ({ members: m, edges: internalSyncEdges(g, m), loop: cycleLoop(g, m) }))
    .sort((a, b) => (g.order.get(a.members[0] ?? '') ?? 0) - (g.order.get(b.members[0] ?? '') ?? 0));
}

/**
 * Signal 4: the longest chain of synchronous calls — where latency
 * accumulates.
 *
 * Null when the CONDENSED graph has no path of two or more steps. That covers
 * two different documents and the surface must not merge them: one with no
 * synchronous edge at all, and one whose entire synchronous subgraph is a
 * single strongly connected component (three services calling each other in a
 * ring condense to one step). The second still accumulates latency, and it is
 * reported — under `syncCycles`, which is where a cycle belongs; §15.2's
 * implementation note is explicit that a cycle is a finding in its own right
 * and never something to traverse silently. `analysisIsChainlessCycle` on the
 * assembled result tells the two apart so the surface can say which it is.
 */
export function longestSyncChain(g: RuntimeGraph): SyncChain | null {
  const { compOf, members } = condenseSync(g);
  const n = members.length;
  if (n === 0) return null;

  // condensation DAG, deduplicated, plus the edge that justified each arc
  const arcs = new Map<number, Map<number, string>>();
  const indegree = new Array<number>(n).fill(0);
  for (const e of g.edges) {
    if (!e.sync) continue;
    const a = compOf.get(e.from);
    const b = compOf.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    let row = arcs.get(a);
    if (row === undefined) {
      row = new Map<number, string>();
      arcs.set(a, row);
    }
    if (!row.has(b)) {
      row.set(b, e.id);
      indegree[b] = (indegree[b] ?? 0) + 1;
    }
  }

  // Every tie below is broken by DOCUMENT ORDER, using each component's first
  // member. Two four-deep chains (one per client, say) are equally long and
  // the answer must not depend on which one Kosaraju happened to number
  // first — an analysis that reshuffles its headline finding between two
  // identical documents is not a measurement.
  const rank = (c: number): number => g.order.get((members[c] ?? [])[0] ?? '') ?? 0;

  // Kahn's algorithm, always taking the lowest-ranked ready component.
  const topo: number[] = [];
  const ready = [...Array(n).keys()].filter((i) => (indegree[i] ?? 0) === 0);
  const degree = [...indegree];
  while (ready.length > 0) {
    let pick = 0;
    for (let i = 1; i < ready.length; i += 1) {
      if (rank(ready[i] as number) < rank(ready[pick] as number)) pick = i;
    }
    const cur = ready.splice(pick, 1)[0] as number;
    topo.push(cur);
    for (const next of arcs.get(cur)?.keys() ?? []) {
      degree[next] = (degree[next] ?? 0) - 1;
      if ((degree[next] ?? 0) === 0) ready.push(next);
    }
  }
  // A condensation is acyclic by construction, so topo covers every component;
  // the guard is here only so a future change cannot silently truncate a chain.
  if (topo.length !== n) return null;

  const best = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (const cur of topo) {
    for (const next of arcs.get(cur)?.keys() ?? []) {
      const candidate = (best[cur] ?? 1) + 1;
      const standing = best[next] ?? 1;
      const incumbent = prev[next] ?? -1;
      const better =
        candidate > standing ||
        (candidate === standing && incumbent !== -1 && rank(cur) < rank(incumbent));
      if (better) {
        best[next] = candidate;
        prev[next] = cur;
      }
    }
  }

  let end = 0;
  for (let i = 1; i < n; i += 1) {
    const longer = (best[i] ?? 1) > (best[end] ?? 1);
    const tied = (best[i] ?? 1) === (best[end] ?? 1) && rank(i) < rank(end);
    if (longer || tied) end = i;
  }
  if ((best[end] ?? 1) < 2) return null;

  const chain: number[] = [];
  for (let cur = end; cur !== -1; cur = prev[cur] ?? -1) chain.unshift(cur);

  const path = chain.map((c) => (members[c] ?? [])[0] as string);
  const edges: string[] = [];
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const id = arcs.get(chain[i] as number)?.get(chain[i + 1] as number);
    if (id !== undefined) edges.push(id);
  }
  const cycles = chain
    .map((c) => members[c] ?? [])
    .filter((m) => m.length > 1)
    .map((m) => ({ members: m, edges: internalSyncEdges(g, m), loop: cycleLoop(g, m) }));

  return {
    path,
    depth: path.length,
    edges,
    throughCycle: cycles.length > 0,
    cycles,
  };
}

// ---------------------------------------------------------------------------
// 5. boundary crossings
// ---------------------------------------------------------------------------

/**
 * A pair of containers and the edges that cross between them. `null` is the
 * top level — the document root — which the surface prints as "root".
 *
 * "Differ in group ancestry" is read as differ in IMMEDIATE parent: a node in
 * vpc-private talking to a node in region-eu (which contains that vpc) really
 * does cross a boundary, and reporting only sibling-to-sibling hops would miss
 * exactly the nested case the group hierarchy exists to express.
 */
export type BoundaryCrossing = {
  /** the outer end of the pair, or null for the top level */
  from: string | null;
  to: string | null;
  count: number;
  /** the crossing edges, in document order */
  edges: string[];
};

/** How a boundary pair is printed when the container is the document root. */
export const ROOT_BOUNDARY_LABEL = 'root';

/**
 * Signal 5: every edge whose endpoints sit in different containers, bucketed
 * per unordered container pair — each one is a network hop the box diagram
 * hides.
 */
export function boundaryCrossings(g: RuntimeGraph): BoundaryCrossing[] {
  // Groups are ordered by their position in doc.groups; the root sorts last,
  // which is what makes §15.4's "vpc-private ↔ root" come out that way round.
  const groupRank = new Map<string, number>(g.doc.groups.map((gr, i) => [gr.id, i]));
  const rank = (c: string | null): number =>
    c === null ? Number.MAX_SAFE_INTEGER : (groupRank.get(c) ?? Number.MAX_SAFE_INTEGER - 1);

  const buckets = new Map<string, BoundaryCrossing>();
  for (const e of g.edges) {
    const a = g.parentOf.get(e.from) ?? null;
    const b = g.parentOf.get(e.to) ?? null;
    if (a === b) continue;
    const [lo, hi] = rank(a) <= rank(b) ? [a, b] : [b, a];
    const key = `${lo ?? ''}|${hi ?? ''}`; // `|` cannot occur in an id (§3.1)
    const hit = buckets.get(key);
    if (hit === undefined) {
      buckets.set(key, { from: lo, to: hi, count: 1, edges: [e.id] });
    } else {
      hit.count += 1;
      hit.edges.push(e.id);
    }
  }
  return [...buckets.values()].sort(
    (x, y) => y.count - x.count || rank(x.from) - rank(y.from) || rank(x.to) - rank(y.to),
  );
}
