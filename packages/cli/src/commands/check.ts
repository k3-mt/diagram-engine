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

/** Statuses whose rows are listed one by one. `ok` is a count and nothing more. */
const LISTED: ReadonlySet<BindingStatus> = new Set<BindingStatus>([
  'unchecked',
  'missing',
  'stale',
  'escaped',
  'malformed',
]);

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
  const rows = STATUS_ORDER.filter((s) => report.counts[s] > 0);
  const listed = report.results.filter((r) => LISTED.has(r.status));

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
    if (!LISTED.has(status)) {
      lines.push(head);
      continue;
    }
    const items = report.results.filter((r) => r.status === status);
    lines.push(`${head}   ${detail(items[0] as ResolvedBinding)}`);
    for (const r of items.slice(1)) lines.push(`${hang}${detail(r)}`);
  }

  // The verdict, on failure only. CI reads exit codes, people read the last
  // line, and an agent needs to be told which of the two claims it can act on:
  // an unchecked identifier is not a defect, a missing file is.
  if (!report.ok) {
    const bad =
      report.counts.missing +
      report.counts.stale +
      report.counts.escaped +
      report.counts.malformed;
    lines.push(
      `${plural(bad, 'citation')} ${bad === 1 ? 'does' : 'do'} not resolve — ` +
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
