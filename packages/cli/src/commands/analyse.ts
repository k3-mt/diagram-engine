// commands/analyse.ts — `diagram analyse` and its MCP twin (spec §15.4, P5-05).
//
// Part 15's division of labour is the whole design: the ENGINE computes the
// structural facts, the AGENT supplies the judgment. So this file renders
// numbers and nothing else. It never writes "postgres is your bottleneck",
// because the document cannot support that claim; it writes "postgres fan-in 9
// (7 sync)" and leaves the sentence about what to do to the reader who has
// also read the codebase.
//
// The computation is core's — analysis/analyse.ts — and this is only a
// renderer over the `Analysis` it returns. Two consequences worth stating:
//
//   * The CLI and diagram_analyse call runAnalyse and print what it hands
//     back, so the two surfaces cannot drift (spec §4.2, asserted byte for
//     byte in tests/integration.test.ts).
//   * The honesty contract is enforced in core and merely OBEYED here:
//
//       A1  This is a read. It never calls applyAndCommit, never takes the
//           lock, and writes no file — analysing a diagram cannot change it.
//       A2  It passes the STORED document to analyse(), never deriveView's
//           output. When a view is set the scope line says so out loud, since
//           an agent that ran `diagram view exec` would otherwise reasonably
//           assume it was being told about the four boxes it can see.
//       A3  Every line below is structural. The only operational thing printed
//           is the NAMES of the meta keys the document carries, in the coverage
//           block, which is what an attribution would have to cite.
//       A4  The coverage block prints analysis.notes verbatim — the exclusions
//           and the blind spots, in core's wording, never re-phrased and never
//           omitted. Omitting them is what makes a partial analysis read as a
//           complete one, which §15.3 calls worse than none.
//       A5  Same block, same reason: how many nodes carry no operational meta.
//
// Runtime import of core by relative path — see commands/get.ts for why — and
// specifically of `analysis/index.js` rather than core's barrel, which pulls
// in node:fs.

import type { Command } from 'commander';
import {
  CHOKEPOINT_MIN_SHARED_DEPENDENCY,
  ROOT_BOUNDARY_LABEL,
  analyse,
  analysisIsChainlessCycle,
  type Analysis,
  type ArticulationPoint,
  type BoundaryCrossing,
  type NodeSignals,
  type SyncChain,
  type SyncCycle,
} from '../../../core/src/analysis/index.js';
import type { GraphDoc } from '../../../core/src/schema/graph.js';
import {
  createContext,
  emit,
  failed,
  loadDoc,
  ok,
  collapsedScopeNote,
  plural,
  renderReadFailure,
  truncatedList,
  type CommandResult,
  type ContextOptions,
} from './context.js';

export type AnalyseOptions = ContextOptions;

/** The arrow between two steps of a dependency path — the same one §15.4 uses. */
const ARROW = '→';

/**
 * How a TWO-member cycle reads inside a chain step. Two members of one
 * strongly connected component can only be mutually connected by a direct edge
 * each way, so `a ⇄ b` is provably true there and nowhere else — a three-member
 * ring has no mutual pair at all, and printing `a ⇄ b ⇄ c` for it asserts four
 * edges the document does not contain.
 */
const LOOP = '⇄';

/** How many entry points to name before falling back to a count. */
const MAX_ENTRY_POINTS = 12;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * One titled block of §15.4's output: a heading at column 0, its rows indented
 * two spaces, and a blank line in front of it. Empty blocks are dropped by the
 * caller rather than printed as a heading with nothing under it — except the
 * coverage block, which is never empty and never optional (A4, A5).
 */
function block(title: string, rows: string[]): string[] {
  return rows.length === 0 ? [] : ['', title, ...rows.map((r) => `  ${r}`)];
}

/** Pad ids into a column so the numbers line up down the page. */
function column(ids: string[]): (id: string) => string {
  const width = Math.max(0, ...ids.map((i) => i.length));
  return (id) => id.padEnd(width);
}

/**
 * A chokepoint row: the id, its fan-in split sync/async, then whichever of the
 * two structural reasons apply.
 *
 * Fan-in is stated first because it is the one number on the row that is true
 * of the node by itself. "articulation point" and "reached by N entry points"
 * are facts about the node's position in the whole graph, and reading them in
 * that order is how the agent gets from "big" to "load-bearing".
 */
/**
 * `articulation point — isolates 4 nodes`.
 *
 * Nodes and boundaries are counted with their own nouns. A group is a vertex
 * of the projection whenever an edge names it (§3.1), and calling a cut-off
 * boundary a "node" is the vocabulary merge §18.3's third detail is about.
 */
function articulationClause(a: ArticulationPoint): string {
  const boundaries = a.isolatedBoundaries.length;
  if (a.isolates === 0 && boundaries === 0) {
    return `articulation point — splits the diagram into ${plural(a.components, 'piece')}`;
  }
  const tail =
    boundaries === 0 ? '' : ` and ${boundaries} ${boundaries === 1 ? 'boundary' : 'boundaries'}`;
  return `articulation point — isolates ${plural(a.isolates, 'node')}${tail}`;
}

function chokepointRow(s: NodeSignals, pad: (id: string) => string): string {
  const parts = [`${pad(s.id)}  fan-in ${s.fanIn.total} (${s.fanIn.sync} sync)`];
  if (s.articulation !== null) {
    parts.push(articulationClause(s.articulation));
  }
  if (s.sharedDependency >= CHOKEPOINT_MIN_SHARED_DEPENDENCY) {
    parts.push(`reached by ${plural(s.sharedDependency, 'entry point')}`);
  }
  return parts.join('   ');
}

/**
 * One condensed step of a chain that is a CYCLE rather than a single node.
 *
 * Two members is the only size at which `⇄` is a fact: a strongly connected
 * component of exactly two can only be connected by one direct edge each way,
 * so `orders ⇄ inventory` asserts nothing the document does not contain. At
 * three or more there need be no mutual pair anywhere — a one-way ring
 * a→b→c→a has none — so the members are printed as what they are, an
 * unordered set with a count, and the ordered truth is left to the
 * `sync cycles` block below, which prints a real closed walk.
 */
function cycleStep(cycle: SyncCycle): string {
  return cycle.members.length === 2
    ? `(${cycle.members.join(` ${LOOP} `)})`
    : `(cycle of ${cycle.members.length}: ${cycle.members.join(', ')})`;
}

/**
 * The longest synchronous chain, as a path with its depth.
 *
 * A condensed step that is a CYCLE is never printed as a plain id: the chain
 * runs through a loop there, and drawing it as a straight line would hide the
 * one part of the path that is a finding in its own right (§15.2's
 * implementation note — a cycle is reported as a cycle, never silently
 * traversed).
 *
 * `depth` is counted in CONDENSED steps, and a whole component is one step, so
 * whenever the chain passes through a cycle the number is labelled as what it
 * is. A reader who takes "depth 3" for three synchronous hops through a
 * twenty-node component has been told something false by a true number.
 */
function chainRow(chain: SyncChain): string {
  const cycles = new Map<string, SyncCycle>(
    chain.cycles.map((c) => [c.members[0] as string, c]),
  );
  const steps = chain.path.map((id) => {
    const cycle = cycles.get(id);
    return cycle === undefined ? id : cycleStep(cycle);
  });
  const depth = chain.throughCycle
    ? `depth ${chain.depth} condensed steps`
    : `depth ${chain.depth}`;
  const note = chain.throughCycle ? ', through a cycle' : '';
  return `${steps.join(` ${ARROW} `)}    (${depth}, all sync${note})`;
}

/**
 * `orders → inventory → orders` — a REAL closed walk, every arrow of which is
 * an edge of the document.
 *
 * `cycle.members` is document order, and document order is not a traversal
 * order: joining it with `→` printed arrows that do not exist, and for a
 * three-member component running against document order every arrow printed
 * was the exact reverse of a real one. `→` means caller → callee everywhere
 * else in this output (§4.4 rule 4), and direction is the one quantity §18.10
 * gate 2 exists to protect, so this row is built from `cycle.loop` — core's
 * shortest genuine cycle through the component.
 *
 * A strongly connected component need not be a single ring, so the loop may
 * not cover every member. The rest are then NAMED rather than folded into the
 * arrows, because "these five are one cycle" and "these five are a ring in
 * this order" are different claims.
 */
function cycleRow(cycle: SyncCycle): string {
  const loop = cycle.loop.length > 0 ? cycle.loop : cycle.members;
  const closed = [...loop, loop[0]].join(` ${ARROW} `);
  const covered = new Set(loop);
  const rest = cycle.members.filter((m) => !covered.has(m));
  return rest.length === 0
    ? closed
    : `${closed}   (+${rest.length} more in the same cycle: ${rest.join(', ')})`;
}

/** `vpc-private ↔ root: 6 edges`. The document root is named, not left blank. */
function crossingRow(c: BoundaryCrossing): string {
  const name = (id: string | null): string => id ?? ROOT_BOUNDARY_LABEL;
  return `${name(c.from)} ↔ ${name(c.to)}: ${plural(c.count, 'edge')}`;
}

/**
 * Which entry points exist, and how much each pushes into the graph.
 *
 * It is here because every shared-dependency number on the rows above is
 * counted against this list, and "reached by 3 entry points" means nothing to
 * a reader who does not know there are four. Fan-out rides along on the same
 * line: it is the sixth signal, and an entry point is the one place it reads
 * as something other than trivia.
 */
function entryPointRows(a: Analysis): string[] {
  if (a.entryPoints.length === 0) return [];
  const byId = new Map(a.nodes.map((n) => [n.id, n]));
  const named = a.entryPoints.map((id) => {
    const out = byId.get(id)?.fanOut.total ?? 0;
    return `${id} (fan-out ${out})`;
  });
  return [truncatedList(named, MAX_ENTRY_POINTS)];
}

// ---------------------------------------------------------------------------
// The whole output
// ---------------------------------------------------------------------------

/**
 * The scope line — A2 made visible.
 *
 * When nothing is collapsed it is one short fact. When a view IS set it says
 * that the view was ignored, because that is the moment the reader's mental
 * picture and the analysis's subject genuinely differ, and an analysis of
 * fourteen nodes handed to someone looking at four boxes is misread in a way
 * no later line can undo.
 */
function scopeLine(a: Analysis, doc: GraphDoc): string {
  const base = `scope: full document, ${plural(a.nodes.length, 'runtime node')}`;
  // The A2 sentence is the spine's, not this file's: `blast-radius` owes the
  // reader the same fact and must not say it differently.
  const note = collapsedScopeNote(doc);
  return note === null ? base : `${base} — ${note}`;
}

/**
 * The operational keys the document carries, EACH with its own count.
 *
 * `coverage.keys` is the union of every key seen anywhere and `withMeta`
 * counts nodes carrying any key at all, so printing the two in apposition —
 * "keys are rps, p99 (on 3 of 3 nodes)" — reads as "each of these is on 3 of
 * 3", which is false whenever more than one key exists and false in the
 * direction that flatters the document. A3 tells the reader to name the key
 * when stating a number from it; this is the line they would cite, so every
 * number on it is per key.
 */
function coverageKeyLine(a: Analysis): string {
  const keys = a.coverage.keys;
  const listed = keys
    .map((k) => `${k} (${a.coverage.keyCounts[k] ?? 0} of ${a.coverage.nodes})`)
    .join(', ');
  const lead = keys.length === 1 ? 'the only operational key it carries is' : 'the operational keys it carries are';
  return `${lead} ${listed} — name the key when you state a number from it`;
}

/**
 * Render an `Analysis` as the terse text of §15.4.
 *
 * Pure: same data in, same string out, no disk and no clock. Both surfaces
 * call it, which is what makes them byte-identical.
 */
export function renderAnalysis(a: Analysis, doc: GraphDoc): string {
  const head = [`analysis — ${a.title}`, scopeLine(a, doc)];

  // The coverage block is built first and appended last so that no early
  // return can produce an analysis without it (A4, A5). `notes` is core's
  // wording, verbatim: the CLI, the MCP tool and the viewer all print the
  // same sentences, and none of them gets to soften one.
  const coverage = block('coverage', [
    ...a.notes,
    ...(a.coverage.keys.length > 0 ? [coverageKeyLine(a)] : []),
  ]);

  if (a.nodes.length === 0) {
    return [...head, '', 'nothing to analyse — this document has no runtime nodes', ...coverage]
      .join('\n');
  }

  const pad = column(a.chokepoints.map((s) => s.id));
  // The four blocks that are FINDINGS. Entry points are excluded from this
  // list on purpose: every graph with a node has at least one, so counting
  // them as a finding would mean "nothing was found" could never be said.
  const findings = [
    ...block('chokepoints', a.chokepoints.map((s) => chokepointRow(s, pad))),
    ...block(
      'sync chains',
      a.longestSyncChain !== null
        ? [chainRow(a.longestSyncChain)]
        : analysisIsChainlessCycle(a)
          ? ['none — the synchronous subgraph does not extend beyond a single cycle (below)']
          : [],
    ),
    ...block('sync cycles', a.syncCycles.map(cycleRow)),
    ...block('boundary crossings', a.boundaryCrossings.map(crossingRow)),
  ];

  // "Nothing found" is itself a finding, and one an agent must be able to tell
  // apart from a renderer that dropped its blocks. It is stated, not implied
  // by silence — and it is a statement about STRUCTURE, which is why it names
  // what was looked for rather than concluding the system is healthy.
  const body =
    findings.length > 0
      ? findings
      : ['', 'no chokepoints, sync chains, cycles or boundary crossings in this document'];

  return [...head, ...body, ...block('entry points', entryPointRows(a)), ...coverage].join('\n');
}

/**
 * Build the `diagram analyse` output.
 *
 * A missing document is not a failure — there is nothing wrong with a project
 * nobody has drawn in yet — so it answers the way `check` does: ok, one line,
 * and where the file would be. An UNREADABLE document is a failure, reported
 * in the shared read-failure shape.
 */
export function runAnalyse(opts: AnalyseOptions = {}): CommandResult {
  const ctx = createContext(opts);
  const loaded = loadDoc(ctx);
  if (!loaded.ok) {
    return failed(renderReadFailure(ctx.paths.graphFile, loaded.errors));
  }
  if (!loaded.existed) {
    return ok(
      [
        `nothing to analyse — no document yet at ${ctx.paths.graphFile}`,
        '(add nodes with `diagram patch` / diagram_patch)',
        // A5 without an exception: coverage is reported on EVERY run, and the
        // honest coverage of a document that does not exist is none of it.
        'coverage: no document, so nothing is known about anything',
      ].join('\n'),
    );
  }
  // A2: the stored document, never deriveView(doc). A1: no write path, no lock.
  return ok(renderAnalysis(analyse(loaded.doc), loaded.doc));
}

/** The command body: print and set the exit code (never process.exit — see get.ts). */
export function analyseCommand(opts: AnalyseOptions = {}): CommandResult {
  const result = runAnalyse(opts);
  emit(result);
  return result;
}

/**
 * Register `diagram analyse` on the program. Called by bin/diagram.ts.
 *
 * `analyze` is an alias rather than a second command: the spec spells it the
 * British way and so does the MCP tool, but an agent that types the American
 * spelling should get the analysis, not a usage error.
 */
export function registerAnalyse(program: Command): void {
  program
    .command('analyse')
    .alias('analyze')
    .description('report the structural pressure signals in the diagram (chokepoints, chains, boundaries)')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action((opts: { dir?: string }) => {
      analyseCommand({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
    });
}
