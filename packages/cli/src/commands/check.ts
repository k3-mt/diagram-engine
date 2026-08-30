// commands/check.ts — `diagram check [--bindings] [--root <path>]`
// (spec §3.3, §3.8, §4.2; M6 Step 15, P5-02).
//
// Validates .diagram/graph.json and changes nothing. This is the command a
// CI step or a git hook runs, and the one an agent runs after hand-editing the
// file through the file protocol (spec Part 4) to find out whether what it
// wrote will be accepted before it asks anyone to look at it.
//
// Exit 0 and one line on stdout when the document is valid; exit 1 and the
// V1–V19 messages on stderr when it is not. The messages are core's verbatim —
// they are the contract the agent self-corrects from, so nothing here rewords
// them; this only frames them with a headline and a two-space indent, the same
// framing renderRejection uses, so one output shape covers every failure the
// agent sees.
//
// ---------------------------------------------------------------------------
// P5-02: --bindings, and why it is a flag on THIS command
// ---------------------------------------------------------------------------
//
// §3.8's deterministic check is `diagram check --bindings`, not a command of
// its own, and three decisions sit behind that spelling.
//
// 1. IT EXTENDS `check` RATHER THAN RUNNING ALONE. Validation runs first, and
//    an invalid document is reported and NOT resolved. V16 is what guarantees
//    every ref is a parseable, repo-relative, non-escaping string; on a
//    document that fails validation the resolver's answers are noise built on
//    a broken base, and a screenful of "missing" rows caused by a malformed
//    document sends the agent to delete correct citations. This is the V13
//    precedent — one mistake, one error — applied across a command boundary.
//
// 2. PLAIN `check` DOES NOT RESOLVE BINDINGS. `diagram check` today reads
//    exactly one file, the document, and answers a question about the document
//    alone: is it well formed? Resolution asks a different question — does
//    this document still match the tree in front of me? — and answers it by
//    stat-ing arbitrary paths across the repository. Folding that into the
//    default would silently change what an already-green CI step means: a
//    sparse checkout, a docs-only job, or the same document vendored into
//    another repository would start failing on a document that is perfectly
//    valid, and the failure would name files rather than the checkout. Green
//    must keep meaning what it meant.
//
// 3. THE DEFAULT STILL HAS TO MAKE IT DISCOVERABLE, because a check nobody
//    runs is a check that does not exist. So plain `check` on a document that
//    CARRIES bindings prints one line saying they were not resolved and how to
//    resolve them — and a document with no bindings pays nothing at all, the
//    same rule §4.1's optional table sections follow. That is the whole
//    compromise: the flag is advertised on every run that could use it,
//    without changing what a passing run promises.
//
// `--root` implies `--bindings`: naming a root and not resolving anything is
// not a thing anyone means.
//
// ---------------------------------------------------------------------------
// Does `unchecked` block exit 0? No — and here is the argument
// ---------------------------------------------------------------------------
//
// Exit 1 for missing, stale, escaped, malformed. Exit 0 with `unchecked`
// present. The three reasons, in order of how much they weigh:
//
// 1. THE AUTHOR CANNOT FIX IT BY EDITING THE DIAGRAM. Every remaining
//    unchecked reason is a fact about a file this checker cannot read
//    precisely without a YAML parser it is not allowed to depend on:
//    flow-style `services: {orders-api: {}}`, a `<<:` merge key, tab indents,
//    a file over the size ceiling. The citation may be perfectly true. The
//    only edit a red build leaves its author is to DELETE it — so a checker
//    that failed here would make diagrams less cited, which is the exact
//    opposite of what rule 15 is for. A gate whose only remedy is "claim less"
//    is not a gate, it is a deterrent.
//
// 2. IT WOULD MAKE THE FLAG UNADOPTABLE, AND AN UNRUN CHECK VERIFIES NOTHING.
//    One flow-style compose file anywhere under `--root` would pin a repo's CI
//    red forever with no action available. §3.8's first property is that this
//    runs in CI on every commit; a check teams turn off because it cannot go
//    green does not.
//
// 3. THE PRESSURE BELONGS ON THE NUMBER, NOT THE EXIT CODE. The obvious worry
//    is an agent scoring a clean run by citing only in forms nothing can
//    verify. What stops that is the headline — `verified 14 of 22 citations`,
//    whose denominator is every binding — and the eval's `verifiedShare`,
//    which counts unchecked against the agent. Citing unverifiably lowers the
//    number it is graded on; it does not buy a green tick for free.
//
// And the loophole that WOULD have made this indefensible is already shut by
// §3.8's rule 1: citing `terraform=...` in a repository holding no `.tf` file
// is `missing`, not `unchecked`, and fails. What is left in `unchecked` is
// only ever "there are files of the right kind, and this one could not be read
// precisely" — a limit of the tool, reported as one.
//
// Runtime import of core by relative path — see commands/get.ts for why.

import * as path from 'node:path';
import type { Command } from 'commander';
import {
  resolveBindings,
  summariseBindings,
  validate,
  type BindingReport,
  type BindingStatus,
  type ResolvedBinding,
} from '../../../core/src/index.js';
import {
  createContext,
  emit,
  failed,
  loadDoc,
  ok,
  plural,
  renderCounts,
  renderReadFailure,
  renderStaleCollapsedLine,
  type CommandResult,
  type ContextOptions,
} from './context.js';

export interface CheckOptions extends ContextOptions {
  /** Resolve every binding against the filesystem (spec §3.8). */
  bindings?: boolean;
  /**
   * The project root a repo-relative ref is resolved against. Default: the
   * parent of the .diagram directory — a ref is repo-relative, so
   * `repo=internal/pay.go` means the repository's internal/, never
   * .diagram/internal/. Implies --bindings.
   */
  root?: string;
}

/**
 * `invalid — 2 problems` plus one indented message per violation. The count is
 * on the headline so an agent fixing a long list can tell at a glance whether
 * its last attempt made things better or worse.
 */
export function renderInvalid(errors: string[]): string {
  const n = errors.length;
  return [
    `invalid — ${n} ${n === 1 ? 'problem' : 'problems'}`,
    ...errors.map((e) => `  ${e}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The binding report (spec §3.8)
// ---------------------------------------------------------------------------

/**
 * The order the statuses are printed in: what passed, what could not be
 * checked, then the failures. Reading down the block goes from "fine" to
 * "fix this", and the order never depends on the data, so two runs over the
 * same tree produce byte-identical text.
 */
const STATUS_ORDER: readonly BindingStatus[] = [
  'ok',
  'unchecked',
  'missing',
  'stale',
  'escaped',
  'malformed',
] as const;

/** Statuses whose rows are always listed one by one. */
const LISTED: ReadonlySet<BindingStatus> = new Set<BindingStatus>([
  'unchecked',
  'missing',
  'stale',
  'escaped',
  'malformed',
]);

/**
 * Which rows get a line of their own.
 *
 * Every failure does, so the agent can find the exact string to fix. A path
 * that resolved does NOT — twenty verified files is a count, and printing them
 * would bury the two that failed.
 *
 * An `ok` IDENTIFIER does, because it carries evidence a count cannot: the
 * file and line the definition was found in. `compose=orders-api` resolved by
 * searching a tree is a claim about a search, and a reader who cannot see
 * which file answered it has to take the tool's word — which is the posture
 * this whole feature exists to replace.
 */
function isListed(r: ResolvedBinding): boolean {
  return LISTED.has(r.status) || r.reason !== '';
}

/** Column widths, chosen so `ok        20` matches §3.8's sample exactly. */
const STATUS_WIDTH = 10;
const MIN_COUNT_WIDTH = 2;
const GAP = '    ';

/**
 * Render a resolved report as §3.8's block:
 *
 *   bindings — 14 elements, 22 bindings
 *   root: /repo
 *     ok        20
 *     missing    1   orders    repo=services/orders/       no such path
 *     stale      1   e7        repo=internal/pay.go:412    file has 120 lines
 *
 * Pure: same report in, same string out. Both the CLI and diagram_check call
 * it, which is what makes the two surfaces byte-identical (§4.2).
 *
 * Every failing binding is listed individually rather than summarised. The
 * point of the line is that the agent can find the exact string to fix in the
 * document, which is why the middle column is `formatBinding` — the same
 * spelling the get-table's `### Bindings` section prints.
 */
export function renderBindingReport(report: BindingReport): string {
  // A status with nothing in it is not printed — except `unchecked`, which is
  // printed at zero too. §3.8: "the count of unchecked bindings is always
  // reported, so the gap is visible rather than absorbed into a passing
  // number." A row that appears only when the news is bad teaches a reader to
  // skim for it, and a reader who does not see it assumes zero rather than
  // knowing it. `unchecked  0` is the shape of the promise being kept.
  const rows = STATUS_ORDER.filter((s) => report.counts[s] > 0 || s === 'unchecked');
  const listed = report.results.filter(isListed);

  const countWidth = Math.max(
    MIN_COUNT_WIDTH,
    ...rows.map((s) => String(report.counts[s]).length),
  );
  const idWidth = Math.max(0, ...listed.map((r) => r.id.length));
  const refWidth = Math.max(0, ...listed.map((r) => r.formatted.length));

  const detail = (r: ResolvedBinding): string =>
    `${r.id.padEnd(idWidth)}${GAP}${r.formatted.padEnd(refWidth)}${GAP}${r.reason}`;

  // Second and later items of one status hang under the first, so the id
  // column is one column down the whole block.
  const hang = ' '.repeat(2 + STATUS_WIDTH + countWidth + 3);

  const lines = [
    `bindings — ${plural(report.elements, 'element')}, ${plural(report.bindings, 'binding')}`,
    `root: ${report.root}`,
  ];
  for (const status of rows) {
    const head = `  ${status.padEnd(STATUS_WIDTH)}${String(report.counts[status]).padStart(countWidth)}`;
    const items = report.results.filter((r) => r.status === status && isListed(r));
    const first = items[0];
    if (first === undefined) {
      lines.push(head);
      continue;
    }
    lines.push(`${head}   ${detail(first)}`);
    for (const r of items.slice(1)) lines.push(`${hang}${detail(r)}`);
  }

  // -------------------------------------------------------------------------
  // The verdict
  // -------------------------------------------------------------------------
  //
  // ALWAYS one headline, and its denominator is every binding in the document
  // — not every binding the checker managed to answer. That is the whole
  // point of the line. A ratio computed over the answerable ones is the shape
  // of number that let a quarter of a corpus's citations sit unverified behind
  // a precision of 1.0, and "22 of 22 checkable" reads exactly like "22 of 22"
  // to anyone not squinting at the word. `verified 14 of 22 citations` cannot
  // be misread: the eight that are not verified are in the sentence, and a
  // large residue drags the headline down instead of hiding under it.
  //
  // Then one advisory per category that needs an action, because the two
  // categories need OPPOSITE actions: an unresolved citation is a wrong claim
  // and the fix is in the document; an unchecked one is a claim written in a
  // form this checker cannot read, and the fix is either a more precise ref or
  // nothing at all.
  const bad =
    report.counts.missing +
    report.counts.stale +
    report.counts.escaped +
    report.counts.malformed;
  const unchecked = report.counts.unchecked;
  const qualifiers = [
    ...(unchecked > 0 ? [`${unchecked} unchecked`] : []),
    ...(bad > 0 ? [`${bad} not resolving`] : []),
  ];
  lines.push(
    `verified ${report.counts.ok} of ${plural(report.bindings, 'citation')}` +
      (qualifiers.length > 0 ? ` — ${qualifiers.join(', ')}` : ''),
  );
  if (unchecked > 0) {
    // Said out loud because the silence is what it would otherwise be mistaken
    // for. `unchecked` is not a pass: the checker looked and could not answer,
    // and a citation nobody can falsify is not evidence of having read
    // anything. §3.8 calls it a residue, not a category the tool is
    // comfortable with, and the row above says why each one landed there.
    lines.push(
      `  ${unchecked === 1 ? 'that one is' : 'those are'} neither verified nor wrong — ` +
        'the checker could not answer; cite a form it can read (§3.8: the residue should be 0)',
    );
  }
  if (bad > 0) {
    lines.push(
      `  ${plural(bad, 'citation')} ${bad === 1 ? 'does' : 'do'} not resolve — ` +
        'fix the ref or remove the binding (rule 15: cite what you opened, nothing else)',
    );
  }
  return lines.join('\n');
}

/**
 * The whole of the `--bindings` output for a document that carries none.
 *
 * A document with no bindings must SAY so. An empty report — a header and an
 * `ok 0` row — reads as a passing check of something, and "22 citations all
 * verified" and "nobody has cited anything" are the two states this feature
 * exists to distinguish. Exit 0 either way: an architecture drawn from a
 * conversation rather than from a repository is not wrong, it is unsourced.
 */
export function renderNoBindings(root: string): string {
  return [
    'bindings — none in this document',
    `root: ${root}`,
    '  nothing to resolve: no node or edge cites a source file',
    '  rule 15: record a binding for each file you actually read the identifier out of',
  ].join('\n');
}

/**
 * The one line plain `check` adds when the document has bindings nobody
 * resolved. Null when it has none, so an architecture-only document pays
 * nothing — the same rule the get-table's optional sections follow.
 */
export function renderUnresolvedBindingsNote(bindings: number): string | null {
  if (bindings === 0) return null;
  return (
    `note: ${plural(bindings, 'binding')} not resolved — ` +
    'run `diagram check --bindings` to check them against the filesystem'
  );
}

// ---------------------------------------------------------------------------
// The command body
// ---------------------------------------------------------------------------

/**
 * Validate the document on disk, and optionally resolve its bindings.
 *
 * Three outcomes for the document, and they are genuinely different:
 * unreadable (bad JSON or wrong shape — the file cannot even be loaded),
 * readable but invalid (V1–V19), and valid. A document that does not exist yet
 * is valid: there is nothing wrong with a project nobody has drawn in.
 *
 * With `--bindings` there is a fourth: valid, but citing files that are not
 * there. That is a failure of the DIAGRAM against the tree rather than of the
 * document against the schema, so it keeps the `ok — <counts>` line for the
 * half that passed and puts the verdict in the binding block.
 */
export function runCheck(opts: CheckOptions = {}): CommandResult {
  const ctx = createContext(opts);
  const wantBindings = opts.bindings === true || (opts.root !== undefined && opts.root !== '');
  // A repo-relative ref resolves against the PROJECT, not against .diagram/.
  const root =
    opts.root !== undefined && opts.root !== '' ? path.resolve(opts.root) : path.dirname(ctx.dir);

  const loaded = loadDoc(ctx);
  if (!loaded.ok) {
    return failed(renderReadFailure(ctx.paths.graphFile, loaded.errors));
  }

  const result = validate(loaded.doc);
  // Decision 1 above: an invalid document is not resolved. V16 is what makes a
  // ref safe to join to a root at all, so resolving past a validation failure
  // would report consequences instead of the cause.
  if (!result.ok) return failed(renderInvalid(result.errors));

  const counts = renderCounts(loaded.doc);
  // There is no V-invariant for `collapsed` (it is presentation, not meaning),
  // so a stale id is a note under a passing check rather than a failure.
  const stale = renderStaleCollapsedLine(loaded.doc);
  const head = [
    loaded.existed ? `ok — ${counts}` : `ok — no document yet at ${ctx.paths.graphFile}`,
    ...(stale === null ? [] : [stale]),
  ];

  const total = summariseBindings(loaded.doc).bindings;

  if (!wantBindings) {
    const note = renderUnresolvedBindingsNote(total);
    return ok([...head, ...(note === null ? [] : [note])].join('\n'));
  }

  if (total === 0) {
    return ok([...head, '', renderNoBindings(root)].join('\n'));
  }

  const report = resolveBindings(loaded.doc, root);
  const text = [...head, '', renderBindingReport(report)].join('\n');
  return report.ok ? ok(text) : failed(text);
}

/** The command body: print and set the exit code (never process.exit — see get.ts). */
export function checkCommand(opts: CheckOptions = {}): CommandResult {
  const result = runCheck(opts);
  emit(result);
  return result;
}

/** Register `diagram check` on the program. Called by bin/diagram.ts (M6 integration). */
export function registerCheck(program: Command): void {
  program
    .command('check')
    .description('validate the diagram document; exit 1 with the problems on stderr')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .option('--bindings', 'also resolve every binding (spec §3.8) against the filesystem')
    .option('--root <path>', 'project root a repo-relative ref resolves against (implies --bindings)')
    .action((opts: { dir?: string; bindings?: boolean; root?: string }) => {
      checkCommand({
        ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        ...(opts.bindings !== undefined ? { bindings: opts.bindings } : {}),
        ...(opts.root !== undefined ? { root: opts.root } : {}),
      });
    });
}
