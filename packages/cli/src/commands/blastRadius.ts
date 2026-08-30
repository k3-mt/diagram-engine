// commands/blastRadius.ts — `diagram blast-radius [id]` (spec §18.5, §18.7; P5-08).
//
// Two questions, one command. With an id: "if this dies, what is at risk?"
// Without one: "what should we break first?" — the ranked experiment backlog
// (§18.4). Both are pure reads of the stored document; the maths lives in
// core/analysis/blast.ts and nothing here recomputes any of it.
//
// The five rules of §18.5, and where each one is actually enforced:
//
//   C1 — THE ENGINE NEVER EXECUTES AN EXPERIMENT. This module reads a file and
//        returns a string. There is no spawn, no fetch, no timer, no writer:
//        nothing in this package can stop a service, and there is no seam here
//        for a later change to add one without it being obvious in review. It
//        is the map and the scoreboard, never the hand on the switch.
//
//   C2 — SYNCHRONOUS TRAVERSAL ONLY, and every containment reported BY NAME.
//        The traversal is core's; this file's obligation is to print the
//        `contained` list rather than let it become an absence. It prints the
//        contained node, the node on the far side of the dashed edge, and the
//        headline says "synchronous only; dashed edges stop propagation" on
//        every single result — including a result with nothing contained,
//        because the reader must be able to tell "no async boundary here" from
//        "async boundaries were not considered".
//
//   C3 — AT RISK, NEVER WILL FAIL. The column is called `at risk`, and the
//        assumptions line is MANDATORY: it is printed on every prediction and
//        on the backlog, verbatim from core, and there is no flag to suppress
//        it. This is the rule under pressure — a confident list of "will fail"
//        reads better and is the one claim the document cannot support — so
//        the honesty sentence is not conditional on anything.
//
//   C4 — EVERY RESULT RECORDS THE DOCUMENT HASH. The `document` line carries a
//        short sha256 of the canonical document, so a prediction pasted into a
//        ticket or a runbook can be checked against the diagram later: same
//        hash, still current; different hash, STALE, and it must not be read as
//        current. It is a DENY-LIST, not a whitelist — every field counts
//        except the ones named in VIEWPORT_FIELDS — because a new DESIGN field
//        must move the hash (a false "current" costs a wrong prediction) while
//        a new viewport field at worst costs a re-run. `collapsed` is on the
//        deny-list: A2 is the guarantee that the prediction does not read it,
//        and this command proves it by printing byte-identical predictions
//        either side of a `diagram view exec`. Marking those stale would put
//        one line saying the view was ignored next to another whose only job is
//        to say the view invalidated the result.
//
//   C5 — RESULTS NEVER ENTER graph.json. The strongest possible enforcement is
//        available here and is what this command does: it writes NOTHING, to
//        graph.json or anywhere else. §18.6 reserves `.diagram/chaos/` for the
//        day predictions and results are stored; `diagram init` already
//        gitignores that directory so nothing can arrive in a commit by
//        accident, and no code path in this file creates it.
//
// A2 (§15.3) also applies: the analysis runs on the FULL document, never the
// derived view. A `diagram view exec` in force does not change one number here,
// and when a view IS set the output says so in one line — otherwise an agent
// reading a four-box picture and an eleven-node radius would think one of them
// was wrong.
//
// Runtime import of core by relative path — see commands/get.ts for why. The
// analysis directory is imported by its own path (like view/derive.js) rather
// than through core's barrel, so this module does not depend on the barrel
// having been extended.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { Command } from 'commander';
import { nearestId, type GraphDoc } from '../../../core/src/index.js';
import {
  articulationValue,
  backlog,
  blastAssumptionsFor,
  blastRadiusOn,
  runtimeGraph,
  type BacklogEntry,
  type BlastRadius,
  type FallenAlternative,
  type RuntimeGraph,
  type SparedNode,
} from '../../../core/src/analysis/index.js';
import {
  collapsedScopeNote,
  createContext,
  emit,
  failed,
  loadDoc,
  ok,
  plural,
  renderCounts,
  truncatedList,
  renderReadFailure,
  renderRefusal,
  type CommandResult,
  type ContextOptions,
  type DiagramContext,
} from './context.js';

export interface BlastRadiusOptions extends ContextOptions {
  /**
   * Rank groups as experiments too — a VPC, region or AZ outage is ONE
   * experiment and the hierarchy already says which components go with it
   * (§18.3 detail 2). Backlog form only; a group id passed as `id` is always
   * a group experiment whether or not this is set.
   */
  groups?: boolean;
}

/** The label column of every keyed line. `at risk (4)` + 4 spaces = 15 (§18.7). */
const LABEL_WIDTH = 15;

/** The parenthetical after every headline — C2, stated whether or not anything was contained. */
const SYNC_ONLY = '(synchronous only; dashed edges stop propagation)';

/** How many backlog rows to print before summarising the tail. */
const MAX_BACKLOG_ROWS = 20;

/** `  at risk (4)    auth, orders` — one keyed line, one place the columns are set. */
function row(label: string, value: string): string {
  return `  ${label.length >= LABEL_WIDTH ? `${label} ` : label.padEnd(LABEL_WIDTH)}${value}`;
}

/**
 * C4 — the document hash a prediction was computed against.
 *
 * Canonical, not the bytes on disk: keys are sorted and whitespace is fixed, so
 * re-serialising the same document (an import, a round-trip through
 * `diagram export json`) gives the same hash, while any change to any field
 * gives a different one. Twelve hex characters is plenty to notice a change and
 * short enough to sit on a terse line; this is a staleness marker, not a
 * signature, and nothing security-sensitive is decided from it.
 */
export function documentHash(doc: GraphDoc): string {
  const hashed = Object.fromEntries(
    Object.entries(doc).filter(([k]) => !VIEWPORT_FIELDS.has(k)),
  );
  return `sha256:${createHash('sha256').update(canonical(hashed)).digest('hex').slice(0, 12)}`;
}

/**
 * Document fields that are PURE VIEWPORT STATE and therefore not part of what
 * a prediction was computed from (§1.4, §7, A2). Everything else is design
 * meaning and moves the hash.
 */
const VIEWPORT_FIELDS = new Set(['collapsed']);

/** JSON with object keys in sorted order, so formatting cannot change the hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The two lines every result ends with: the honesty block (C3) and the hash
 * (C4).
 *
 * The §18.11 redundancy caveat is NOT added here. It arrives inside
 * `assumptions`, from core (`blastAssumptionsFor`), for the same reason C2 and
 * C3's sentences do: an honesty sentence a surface composes is one a surface
 * can drop, and this file used to append it while the viewer appended nothing,
 * which is how the two surfaces came to make different claims about the same
 * document. Which of the two wordings is true of the document in front of the
 * reader is core's decision too — no `alt` anywhere gets the sentence saying
 * this document states no alternatives; one `alt` narrows it to the untagged
 * edges, because rule 14 says redundancy is told, not deduced.
 */

/** The two lines every result ends with: the honesty block (C3) and the hash (C4). */
function footer(doc: GraphDoc, assumptions: string[]): string[] {
  return [
    row('assumptions', assumptions.join('; ')),
    row('document', `${documentHash(doc)} — ${renderCounts(doc)}`),
  ];
}

/**
 * A2 made visible. Printed only when a view is actually set, so the common case
 * pays nothing: an agent that ran `diagram view exec` sees four boxes and would
 * otherwise have no way to reconcile them with an eleven-node radius.
 */
function scopeLine(doc: GraphDoc): string[] {
  // One vocabulary: the clause after the em dash is the spine's, the same one
  // `diagram analyse` hangs off its own scope line (§15.3 A2). This command
  // chooses the layout — a keyed row, like every other line of §18.7 — and
  // nothing about the wording.
  const note = collapsedScopeNote(doc);
  return note === null ? [] : [row('scope', `the full document — ${note}`)];
}

// ---------------------------------------------------------------------------
// The prediction (§18.7)
// ---------------------------------------------------------------------------

/** How many alternatives to name on each side before summarising the tail. */
const MAX_ALTERNATIVES = 4;

/**
 * `orders (alt "db" — lost pg-primary, still up: pg-replica)`
 *
 * A fallen alternative that names a BOUNDARY is worded differently, because
 * "lost az-a" when az-a is intact and one unrelated service inside it died
 * reads as an AZ outage. The edge is genuinely down — a boundary is
 * unavailable as soon as anything inside it is — but what went down has a
 * name, and it is not the AZ's: `lost az-a (other-a is down inside it)`.
 */
function fallenValue(f: FallenAlternative): string {
  return f.downInside === null ? f.target : `${f.target} (${f.downInside} is down inside it)`;
}

function sparedValue(spared: readonly SparedNode[]): string {
  return spared
    .map(
      (s) =>
        `${s.id} (alt "${s.tag}" — lost ${truncatedList(s.lost.map(fallenValue), MAX_ALTERNATIVES)}, still up: ${truncatedList(s.live, MAX_ALTERNATIVES)})`,
    )
    .join('; ');
}

/** Render one prediction, exactly the shape of §18.7. */
export function renderBlastRadius(r: BlastRadius, doc: GraphDoc, g: RuntimeGraph): string {
  const kills =
    r.targetKind === 'group'
      ? ` (boundary — kills ${plural(Math.max(r.killed.length - 1, 0), 'component')})`
      : '';
  const lines = [`blast radius — ${r.target}${kills}   ${SYNC_ONLY}`];

  // §18.11 made the empty at-risk placeholder reachable in a state where it is
  // FALSE. "nothing depends on this synchronously" is a claim about the graph,
  // not about risk; once an alt set holds a dependent up, something does depend
  // on the target synchronously and is simply not endangered. The two lines sat
  // adjacent and said opposite things on the one output this milestone exists
  // to produce, so the placeholder now branches on which of the two is true.
  const spared = r.spared;
  lines.push(
    row(
      `at risk (${r.atRisk.length})`,
      r.atRisk.length > 0
        ? r.atRisk.map((n) => n.id).join(', ')
        : spared.length > 0
          ? 'nothing left at risk — an alternative held, see spared below'
          : 'nothing depends on this synchronously',
    ),
  );
  // §18.11: a node an alt set held up is the most interesting thing on the
  // screen — it is the whole difference between this prediction and the one
  // the same document produced before the redundancy was stated — and it is
  // invisible unless it is named, because being spared is an absence in the
  // at-risk list. It is deliberately NOT folded into `contained`: containment
  // is the design's asynchronous-boundary claim (C2), and a live replica is a
  // different claim about a different mechanism. Printed only when something
  // was actually spared, so a document with no `alt` is byte-for-byte the
  // output it produced before.
  if (spared.length > 0) {
    lines.push(row(`spared (${spared.length})`, sparedValue(spared)));
  }
  // C2: by name, with the node on the far side of the dashed edge that
  // contained it. Omitted only when there is genuinely nothing to name — the
  // headline has already said dashed edges were considered.
  if (r.contained.length > 0) {
    lines.push(
      row(
        `contained (${r.contained.length})`,
        r.contained.map((c) => `${c.id} (async from ${c.from})`).join(', '),
      ),
    );
  }
  lines.push(row('articulation', articulationValue(r)));
  lines.push(...scopeLine(doc));
  lines.push(...footer(doc, r.assumptions));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The backlog (§18.4)
// ---------------------------------------------------------------------------

/** `  1. api-gateway  11 at risk   articulation point` */
function backlogRows(entries: BacklogEntry[]): string[] {
  const shown = entries.slice(0, MAX_BACKLOG_ROWS);
  const idWidth = Math.max(...shown.map((e) => e.id.length)) + 2;
  const numWidth = String(shown.length).length;
  const countWidth = Math.max(...shown.map((e) => String(e.atRisk).length));

  return shown.map((e, i) => {
    const flags = [
      e.kind === 'group' ? 'boundary experiment' : null,
      // A group's own contents are not in `atRisk` — they are already dead —
      // so without this the ranked number understates a boundary experiment.
      e.kills > 0 ? `kills ${plural(e.kills, 'component')}` : null,
      e.articulationPoint ? 'articulation point' : null,
      e.contained > 0 ? `${e.contained} contained` : null,
    ].filter((f): f is string => f !== null);
    const rank = `${String(i + 1).padStart(numWidth)}. `;
    const impact = `${String(e.atRisk).padStart(countWidth)} at risk`;
    return `  ${rank}${e.id.padEnd(idWidth)}${impact}${flags.length > 0 ? `   ${flags.join(', ')}` : ''}`;
  });
}

/** Render the ranked list, or an honest empty answer. */
export function renderBacklog(
  entries: BacklogEntry[],
  doc: GraphDoc,
  g: RuntimeGraph,
): string {
  const assumptions = blastAssumptionsFor(g);

  // Everything with no dependents, no containment claim and no split is not a
  // candidate experiment, it is a leaf. Ranking them fills the screen with
  // zeroes and buries the three rows that matter.
  //
  // `contained > 0` IS a candidate, and a valuable one: a node whose only
  // dependents arrive over dashed edges is precisely the experiment that
  // validates the design's own asynchronous-safety claim, which §18.3 says to
  // state explicitly and §18.8 exists to test. Dropping it was silent, and
  // whatever is dropped is now counted and said out loud (A5).
  // `kills > 0` is on the list for the same reason: a boundary outage that
  // takes out three components is an experiment whether or not anything
  // OUTSIDE it depends on the boundary, and `atRisk` deliberately excludes the
  // contents because they are already dead.
  const ranked = entries.filter(
    (e) => e.atRisk > 0 || e.articulationPoint || e.contained > 0 || e.kills > 0,
  );
  const omitted = entries.length - ranked.length;
  const omittedNote =
    omitted > 0
      ? [
          row(
            'not ranked',
            `${plural(omitted, 'candidate')} with no synchronous dependents, no containment claim and no split`,
          ),
        ]
      : [];
  if (ranked.length === 0) {
    return [
      'experiment backlog — nothing to rank',
      row(
        'note',
        g.nodeIds.length === 0
          ? 'this document has no runtime components'
          : 'no component has synchronous dependents: nothing here cascades',
      ),
      ...scopeLine(doc),
      ...footer(doc, assumptions),
    ].join('\n');
  }

  const head =
    ranked.length > MAX_BACKLOG_ROWS
      ? `experiment backlog — top ${MAX_BACKLOG_ROWS} of ${plural(ranked.length, 'candidate')}   ${SYNC_ONLY}`
      : `experiment backlog — ${plural(ranked.length, 'candidate')}, ranked   ${SYNC_ONLY}`;

  const first = ranked[0] as BacklogEntry;
  return [
    head,
    ...backlogRows(ranked),
    ...omittedNote,
    ...scopeLine(doc),
    ...footer(doc, assumptions),
    // §3.3: say what to do next. The backlog names the experiment; the radius
    // names what it puts at risk, and that is the thing you write down BEFORE
    // running anything (§18.1).
    row('next', `\`diagram blast-radius ${first.id}\` for what it puts at risk`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Refusals (§3.3 — say what to do)
// ---------------------------------------------------------------------------

/** Terse roster: an agent does not need three hundred ids to fix one typo. */
const MAX_LISTED_IDS = 30;

function listIds(label: string, ids: string[]): string {
  return `${label}: ${truncatedList(ids, MAX_LISTED_IDS)}`;
}

/**
 * An id this document does not have, or has only as a table.
 *
 * Core answers both cases with an empty prediction and a `note` rather than a
 * throw, which is right for a pure function and wrong for a surface: a zero
 * radius and an unknown id look identical on screen, and "nothing is at risk"
 * is the single most dangerous thing this command could say by accident. So
 * the surface turns it into a refusal with an exit code, and lists the ids that
 * WOULD work — runtime components and boundaries, the two kinds of thing an
 * experiment can kill.
 */
function refuseTarget(r: BlastRadius, doc: GraphDoc, g: RuntimeGraph): CommandResult {
  const groupIds = doc.groups.map((gr) => gr.id);
  const near = nearestId(r.target, [...g.nodeIds, ...groupIds]);
  const detail = [
    r.note ?? `cannot predict a blast radius for "${r.target}"`,
    ...(near !== undefined ? [`did you mean "${near}"?`] : []),
    // Two different documents reach `nodeIds.length === 0`: a pure ERD, and a
    // document with no nodes at all. Only the first justifies the entity
    // sentence, and asserting an exclusion that did not happen is an A4
    // failure on the surface an agent hits after a typo.
    g.nodeIds.length > 0
      ? listIds('runtime components', g.nodeIds)
      : g.excluded.entityNodes.length > 0
        ? 'this document has no runtime components — every node in it is an entity (a data model)'
        : 'this document has no components yet — draw the architecture first with `diagram patch` / diagram_patch',
    ...(groupIds.length > 0
      ? [listIds('boundaries (killing one kills its components)', groupIds)]
      : []),
    'run `diagram blast-radius` with no id for the ranked backlog',
  ];
  const headline =
    r.targetKind === 'entity'
      ? `entity node "${r.target}" — nothing to predict`
      : `unknown id "${r.target}" — nothing to predict`;
  return failed(renderRefusal(headline, detail));
}

/** No document at all: the one thing this command will not paper over. */
function missingDiagram(ctx: DiagramContext): CommandResult {
  return failed(
    renderRefusal('no diagram — nothing to predict', [
      `no document at ${ctx.paths.graphFile}`,
      'draw the architecture first with `diagram patch` / diagram_patch',
    ]),
  );
}

// ---------------------------------------------------------------------------
// The command body
// ---------------------------------------------------------------------------

/**
 * Build the output without printing it — the shared body the CLI action and
 * the diagram_blast_radius MCP tool both call, which is what makes the two
 * surfaces byte-identical (§4.2).
 *
 * `id` absent (or empty) is the backlog form. Reads the document; writes
 * nothing, anywhere (C1, C5).
 */
export function runBlastRadius(
  id?: string,
  opts: BlastRadiusOptions = {},
): CommandResult {
  const ctx = createContext(opts);
  if (!fs.existsSync(ctx.paths.graphFile)) return missingDiagram(ctx);

  const loaded = loadDoc(ctx);
  if (!loaded.ok) return failed(renderReadFailure(ctx.paths.graphFile, loaded.errors));

  // A2: the FULL document, never deriveView(doc). An `exec` view collapses the
  // very boundaries whose insides carry the chokepoints.
  const doc = loaded.doc;
  const g = runtimeGraph(doc);

  if (id === undefined || id === '') {
    return ok(
      renderBacklog(
        backlog(doc, opts.groups === true ? { includeGroups: true } : {}),
        doc,
        g,
      ),
    );
  }

  const radius = blastRadiusOn(g, id);
  if (radius.note !== null) return refuseTarget(radius, doc, g);
  return ok(renderBlastRadius(radius, doc, g));
}

/** Print it and set the exit code. `process.exitCode`, never process.exit(). */
export function blastRadiusCommand(
  id?: string,
  opts: BlastRadiusOptions = {},
): CommandResult {
  const result = runBlastRadius(id, opts);
  emit(result);
  return result;
}

/** Register `diagram blast-radius [id]`. Called by bin/diagram.ts (the integrator). */
export function registerBlastRadius(program: Command): void {
  program
    .command('blast-radius')
    .argument('[id]', 'the node or group to predict for; omit for the ranked backlog')
    .description('predict what is at risk if a component dies, or rank the experiments')
    .option('--groups', 'rank boundaries too — a VPC, region or AZ outage as one experiment')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action((id: string | undefined, opts: { dir?: string; groups?: boolean }) => {
      blastRadiusCommand(id, {
        ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        ...(opts.groups !== undefined ? { groups: opts.groups } : {}),
      });
    });
}
