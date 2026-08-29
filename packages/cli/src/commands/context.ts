// commands/context.ts — the shared spine of every M6 surface (spec Part 4).
//
// Spec Part 4 promises three ways in — the MCP server, the CLI, and the file
// protocol — that behave identically. The only way that stays true is if all
// three run the same code, so this module owns the whole read-modify-write
// cycle and the two output shapes, and the surfaces above it own nothing but
// argument parsing and where the text is written.
//
// It therefore prints NOTHING and never calls process.exit: the renderers are
// pure functions from data to a string. `diagram patch` puts that string on
// stdout (or stderr, exit 1, on rejection); diagram_patch returns the same
// string as its MCP tool result. One wording, one contract, no drift.
//
// Runtime import of core by relative path (not '@diagram-engine/core'): core
// is consumed as TS source in the workspace and the CLI build compiles core's
// src alongside its own (see tsconfig.build.json), so a relative specifier
// resolves both from src/ under vitest and from dist/ after a build.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyPatch,
  diagramPaths,
  emptyDoc,
  readDoc,
  resolveDiagramDir,
  snapshotHistory,
  withLock,
  writeDocAtomic,
  type DiagramPaths,
  type GraphDoc,
  type GraphPatch,
} from '../../../core/src/index.js';
import { deriveViewDetail } from '../../../core/src/view/derive.js';

/** Options every command shares. `--dir` is the only one that is universal. */
export interface ContextOptions {
  /** .diagram/ directory. Default: DIAGRAM_DIR env, else <cwd>/.diagram. */
  dir?: string;
}

/** A resolved place to work: the directory and every path inside it. */
export interface DiagramContext {
  /** The resolved .diagram/ directory (absolute). */
  dir: string;
  /** graph.json, history/, errors.txt, out.svg, .lock. */
  paths: DiagramPaths;
  /**
   * True when nothing chose this directory: no --dir, no $DIAGRAM_DIR, and no
   * existing .diagram/ at or above the working directory. A write here is
   * creating a brand-new diagram somewhere nobody asked for, which is worth
   * one line of output (see applyAndCommit).
   */
  defaulted?: boolean;
}

/** Reading the current document: a missing file yields the empty document. */
export type LoadResult =
  | { ok: true; doc: GraphDoc; existed: boolean }
  | { ok: false; errors: string[] };

/**
 * The outcome of a patch. `ok` carries everything the renderers need, plus
 * the history index so `undo` knows there is something to undo.
 */
export type PatchResult =
  | {
      ok: true;
      /** The document as written to disk. */
      doc: GraphDoc;
      /** "+3 nodes, +2 edges" — from core's summarise(). */
      summary: string;
      /** ID-collision coercions (spec §3.5); empty when nothing was coerced. */
      notes: string[];
      /** Index of the new history snapshot. */
      history: number;
    }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Where to work
// ---------------------------------------------------------------------------

/**
 * Resolve the .diagram/ directory exactly as `diagram serve` does: an explicit
 * --dir wins, otherwise the DIAGRAM_DIR environment variable (this is how
 * .mcp.json points the MCP server at the workspace, spec §4.1), otherwise
 * <cwd>/.diagram. Kept identical to serve.ts on purpose — a CLI and an MCP
 * server disagreeing about which file they are editing is a bug nobody can see.
 */
export function resolveDir(dir?: string): string {
  return dir !== undefined && dir !== '' ? path.resolve(dir) : resolveDiagramDir();
}

/**
 * How far up the tree the search for an existing .diagram/ may go, so a
 * runaway walk cannot reach the user's home directory.
 */
const MAX_WALK_DEPTH = 40;

/**
 * Look for an existing .diagram/ directory at `from` or above it.
 *
 * WHY THIS EXISTS. An agent cd's into src/ — routine — and every command then
 * resolves <cwd>/.diagram, which does not exist: `diagram get` shows an empty
 * "Untitled" document and `diagram patch` cheerfully creates src/.diagram/,
 * answers `ok`, and forks a second diagram nobody is watching. Nothing in the
 * output says so; the only clue is the node count silently resetting to 1.
 * That is the most likely way a real session goes quietly wrong, so the
 * default resolution searches upward the way git, npm and tsconfig do.
 *
 * The walk stops at a repository root (a directory containing .git) because a
 * project boundary is where "my diagram" ends, and at the filesystem root.
 * Returns undefined when nothing was found — the caller then falls back to
 * <cwd>/.diagram and says so.
 */
export function discoverDir(from: string = process.cwd()): string | undefined {
  let cur = path.resolve(from);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const candidate = path.join(cur, '.diagram');
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not here; keep climbing
    }
    // A repository root is the boundary: never reach past the project.
    if (fs.existsSync(path.join(cur, '.git'))) return undefined;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

/**
 * Resolve the directory and every path inside it.
 *
 * Precedence: an explicit --dir, then $DIAGRAM_DIR (how .mcp.json points the
 * MCP server at the workspace), then an existing .diagram/ at or above the
 * working directory, and only then <cwd>/.diagram. `defaulted` records that
 * last case so a write into a brand-new location can say where it landed
 * instead of looking like an ordinary fresh diagram.
 *
 * Touches no disk except to look for an existing directory; creates nothing.
 */
export function createContext(opts: ContextOptions = {}): DiagramContext {
  const explicit = opts.dir !== undefined && opts.dir !== '';
  const env = process.env['DIAGRAM_DIR'];
  const fromEnv = env !== undefined && env !== '';

  if (explicit || fromEnv) {
    const dir = resolveDir(opts.dir);
    return { dir, paths: diagramPaths(dir), defaulted: false };
  }

  const found = discoverDir();
  const dir = found ?? path.join(process.cwd(), '.diagram');
  return { dir, paths: diagramPaths(dir), defaulted: found === undefined };
}

/**
 * Load the current document. A missing .diagram/graph.json is not an error —
 * it is a project nobody has drawn in yet, so the empty document comes back
 * with `existed: false`. A present-but-broken file IS an error, reported with
 * the parse/validation messages so the agent can fix the file it wrote.
 */
export function loadDoc(ctx: DiagramContext): LoadResult {
  const result = readDoc(ctx.paths.graphFile);
  if (!result.ok) return result;
  // readDoc returns the empty document for a missing file, so it cannot tell
  // "absent" from "drawn then emptied" — ask the path instead.
  return { ok: true, doc: result.doc, existed: fs.existsSync(ctx.paths.graphFile) };
}

// ---------------------------------------------------------------------------
// Read-modify-write
// ---------------------------------------------------------------------------

/**
 * The one write path: under the exclusive .lock, re-read graph.json, apply the
 * patch to whatever is actually on disk, snapshot the result into history and
 * atomically replace graph.json.
 *
 * The re-read inside the lock is the point. Two agent turns racing on the same
 * base document is the realistic failure, and a patch applied to a stale
 * in-memory copy silently discards the other turn's work.
 *
 * Note this does NOT call core's commitDoc: commitDoc takes the same lock, and
 * the lock is a file created with "wx" — it is not reentrant. So it does what
 * commitDoc does (snapshotHistory then writeDocAtomic) inside the lock we are
 * already holding.
 */
export function applyAndCommit(ctx: DiagramContext, patch: GraphPatch): PatchResult {
  return withLock(ctx.dir, (): PatchResult => {
    const current = readDoc(ctx.paths.graphFile);
    if (!current.ok) return { ok: false, errors: current.errors };

    const applied = applyPatch(current.doc, patch);
    if (!applied.ok) {
      return { ok: false, errors: [...applied.errors, ...idHints(current.doc, applied.errors)] };
    }

    // Writing a diagram into a directory nobody chose is worth saying out
    // loud: it means the agent is standing somewhere unexpected (usually a
    // subdirectory) and the document it thinks it is editing is elsewhere.
    const fresh =
      ctx.defaulted === true && !fs.existsSync(ctx.paths.graphFile)
        ? [`created a new diagram at ${ctx.paths.graphFile} (no .diagram/ found at or above the working directory)`]
        : [];

    // snapshotHistory reads the pre-patch graph.json to seed snapshot 0000,
    // so it must run before the write, not after.
    const history = snapshotHistory(ctx.dir, applied.doc);
    writeDocAtomic(ctx.dir, applied.doc);

    return {
      ok: true,
      doc: applied.doc,
      summary: applied.summary,
      notes: [...applied.notes, ...fresh],
      history,
    };
  });
}

/**
 * Create .diagram/ and seed it with an empty, schema-valid graph.json when
 * there is nothing there yet — so a first `diagram patch` in a fresh project
 * has a base document and the viewer has a real file to watch. Idempotent.
 */
export function ensureDoc(ctx: DiagramContext): GraphDoc {
  const loaded = loadDoc(ctx);
  if (loaded.ok && loaded.existed) return loaded.doc;
  if (!loaded.ok) {
    // A file that is THERE but unreadable is not "nothing yet". Seeding over
    // it would destroy a hand-edited document (spec §4.3, path C) and seed
    // history snapshot 0000 from the already-emptied file, so undo could not
    // bring it back — data loss reported as success. Nothing is written; the
    // caller reads the same failure again through loadDoc and renders it.
    return emptyDoc();
  }
  const doc = emptyDoc();
  writeDocAtomic(ctx.dir, doc);
  return doc;
}

// ---------------------------------------------------------------------------
// The two output shapes (spec §4.1)
// ---------------------------------------------------------------------------

/**
 * `1 group` / `2 groups` — the ONE place a count and its noun are joined.
 * Exported because view and export both count groups in their own result
 * lines, and two copies of this is how one surface starts saying "1 groups".
 */
export function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** `11 nodes, 2 groups, 9 edges` — the standing size line under every result. */
export function renderCounts(doc: GraphDoc): string {
  return [
    plural(doc.nodes.length, 'node'),
    plural(doc.groups.length, 'group'),
    plural(doc.edges.length, 'edge'),
  ].join(', ');
}

/**
 * One line saying WHICH PICTURE the stored document currently shows — the
 * §7 collapsed view, in the wording every surface uses.
 *
 * It lives here, in the spine, rather than in `export`, because more than one
 * command has to say it and two hand-written copies is how `get` and
 * `export svg` end up describing the same document differently. `hidden` is
 * deriveView's own count, so the line cannot disagree with what is drawn.
 *
 * `full` is the `diagram export svg --full` case: the stored view was
 * deliberately ignored, which the reader must be told rather than left to
 * infer from a picture with more boxes than they expected.
 */
export function renderViewLine(doc: GraphDoc, full = false): string {
  if (full) {
    return doc.collapsed.length > 0
      ? 'view: full graph (--full) — the stored collapsed view was ignored'
      : 'view: full graph — nothing collapsed';
  }
  const view = deriveViewDetail(doc, doc.collapsed);
  if (view.collapsedGroups.length === 0) {
    // doc.collapsed can name a group a later patch deleted, or a node; the
    // derive pass ignores such an id rather than refusing to draw, and this
    // says so instead of reporting a collapse that did not happen.
    return doc.collapsed.length > 0
      ? `view: full graph — collapsed ${doc.collapsed.join(', ')} ${
          doc.collapsed.length === 1 ? 'is not a group' : 'are not groups'
        } in this diagram`
      : 'view: full graph — nothing collapsed';
  }
  return (
    `view: collapsed ${view.collapsedGroups.join(', ')} ` +
    `(${view.collapsedGroups.length} of ${plural(doc.groups.length, 'group')}), ` +
    `${plural(view.hidden.length, 'element')} hidden`
  );
}

/**
 * A warning line when `collapsed` names something that is not a group in this
 * document — a group a later patch deleted, or a NODE.
 *
 * deriveView deliberately ignores such an id rather than refusing to draw
 * (its decision 6: stale ids must degrade to showing the contents, and it is
 * what makes the pass idempotent). That tolerance is right for the render
 * path and wrong for the WRITE path: `import` and `check` are the two moments
 * an agent could fix the list, and without this line the mistake first
 * surfaces in the `view:` line of an export, several steps later.
 *
 * A warning, never a rejection — refusing here would break the tolerance the
 * viewer relies on and make a deleted group unrecoverable by import.
 */
export function renderStaleCollapsedLine(doc: GraphDoc): string | null {
  const groups = new Set(doc.groups.map((g) => g.id));
  const stale = doc.collapsed.filter((id) => !groups.has(id));
  if (stale.length === 0) return null;
  const ids = stale.map((i) => `"${i}"`).join(', ');
  const names =
    doc.groups.length === 0
      ? 'this diagram has no groups'
      : `groups: ${doc.groups.map((g) => g.id).join(', ')}`;
  return (
    `note: collapsed ${ids} ${stale.length === 1 ? 'is not a group' : 'are not groups'} ` +
    `and ${stale.length === 1 ? 'is' : 'are'} ignored when drawing (${names})`
  );
}

/**
 * The `view:` line for a step that may have changed the view and nothing
 * else — `undo` and `redo`. Null when the collapsed list is unchanged.
 *
 * It exists because collapse is the ONE piece of document state that can move
 * without any count moving: undoing a `diagram view exec` prints exactly the
 * same `graph: 10 nodes, 3 groups, 12 edges` line as the state before it, so
 * an agent reading that line — the line every other undo teaches it to read —
 * cannot tell whether anything happened.
 */
export function renderViewChangeLine(before: GraphDoc, after: GraphDoc): string | null {
  const a = before.collapsed;
  const b = after.collapsed;
  if (a.length === b.length && a.every((x, i) => x === b[i])) return null;
  const was = a.length === 0 ? 'nothing collapsed' : `collapsed ${a.join(', ')}`;
  return `${renderViewLine(after)} (was: ${was})`;
}

/**
 * The success shape (spec §4.1):
 *
 *   ok — +3 nodes, +2 edges
 *   graph: 11 nodes, 2 groups, 9 edges
 *   notes: coerced addNode "auth" to updateNode (id exists)
 *
 * The first line is core's summarise() verbatim, signed deltas and all, so the
 * agent can tell "+2 edges" from "-2 edges" at a glance. The notes line is
 * omitted entirely when nothing was coerced: a line saying nothing happened is
 * a line the agent pays for on every turn.
 *
 * Pure: give it the same data twice and it returns the same string. Both the
 * CLI and the MCP tool call it, which is what makes the two surfaces agree.
 */
export function renderOk(result: {
  doc: GraphDoc;
  summary: string;
  notes?: string[];
}): string {
  const lines = [`ok — ${result.summary}`, `graph: ${renderCounts(result.doc)}`];
  const notes = result.notes ?? [];
  if (notes.length > 0) lines.push(`notes: ${notes.join('; ')}`);
  return lines.join('\n');
}

/**
 * When a patch names an id the document does not have, list the ids it DOES
 * have — once, at the end.
 *
 * Core's V5 message offers a spelling-distance suggestion ("Did you mean
 * \"redis-cache\"?"), which is the right hint when the agent nearly had it.
 * When it invents an id outright there is no near match and the agent is left
 * guessing, so the surface that talks to the agent adds the roster. It is
 * added here, not in core, because it is presentation for one audience — and
 * only when an unknown-id error is actually present, so an ordinary rejection
 * does not carry a wall of ids the agent pays for and ignores.
 */
const UNKNOWN_ID = /unknown (node|group|edge) "/;

function listIds(label: string, ids: string[]): string {
  // Terse: an agent does not need three hundred ids to fix one typo.
  const shown = ids.slice(0, 30);
  const more = ids.length - shown.length;
  return `${label}: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`;
}

/**
 * An unknown ENDPOINT, as opposed to an unknown node anywhere else. Core's V5
 * says `edge "e7" references unknown node "redis"` even when the endpoint could
 * legally have been a GROUP — edges may point at a group — so the roster for
 * this case has to cover the whole namespace the validator actually checks.
 * The `op N (kind): ` prefix is optional because applyPatch now adds it.
 */
const UNKNOWN_ENDPOINT = /edge "[^"]*" references unknown node "/;

function idHints(doc: GraphDoc, errors: string[]): string[] {
  const kinds = new Set<string>();
  for (const e of errors) {
    const m = UNKNOWN_ID.exec(e);
    if (m?.[1] !== undefined) kinds.add(m[1]);
  }
  const endpoint = errors.some((e) => UNKNOWN_ENDPOINT.test(e));
  const hints: string[] = [];
  if (kinds.has('node')) {
    hints.push(
      doc.nodes.length > 0
        ? listIds('known node ids', doc.nodes.map((n) => n.id))
        : 'this diagram has no nodes yet — add the node with addNode before referring to it',
    );
    // An edge endpoint lives in the shared node ∪ group namespace, so a roster
    // of nodes alone can contradict its own "Did you mean ...?" suggestion —
    // and rule 11 tells the agent to trust the roster rather than call
    // diagram_get, so the omission reads as "a group is not a legal endpoint".
    if (endpoint && doc.groups.length > 0) {
      hints.push(
        listIds('known group ids (an edge may point at a group)', doc.groups.map((g) => g.id)),
      );
    }
  }
  if (kinds.has('group')) {
    hints.push(
      doc.groups.length > 0
        ? listIds('known group ids', doc.groups.map((g) => g.id))
        : 'this diagram has no groups yet — add the group before putting anything in it',
    );
  }
  if (kinds.has('edge')) {
    hints.push(
      doc.edges.length > 0
        ? listIds('known edge ids', doc.edges.map((e) => e.id))
        : 'this diagram has no edges yet',
    );
  }
  return hints;
}

/**
 * The rejection shape (spec §4.1):
 *
 *   rejected — no changes applied
 *     op 2 (addEdge): edge "e7" references unknown node "redis". Did you mean "redis-cache"?
 *     op 4 (addNode): invalid id "Order Service": use lowercase-hyphenated
 *
 * The `op N (kind):` prefixes come from applyPatch and the messages from
 * validate — this only frames them. The headline says "no changes applied"
 * because that is the guarantee that lets the agent retry without first
 * re-reading the document to find out how far it got.
 */
export function renderRejection(errors: string[]): string {
  return renderRefusal('rejected — no changes applied', errors);
}

/**
 * The same shape under a different promise. "no changes applied" is a promise
 * about a WRITE; on a read-only command (export, which only ever writes to a
 * destination of its own) it invites a pointless verification turn, because
 * the agent has to work out that its document was never at risk. `diagram
 * check`'s `invalid — 2 problems` headline is the precedent.
 */
export function renderRefusal(headline: string, errors: string[]): string {
  const body = errors.length > 0 ? errors : ['unknown error'];
  return [headline, ...body.map((e) => `  ${e}`)].join('\n');
}

/** Render whichever shape the result is — the whole of a command's output. */
export function renderPatchResult(result: PatchResult): string {
  return result.ok ? renderOk(result) : renderRejection(result.errors);
}

// ---------------------------------------------------------------------------
// The one command-output shape (M6 integration)
// ---------------------------------------------------------------------------

/**
 * What EVERY command body — read or write, CLI or MCP — hands back.
 *
 * The two halves of M6 arrived with two near-identical shapes: the read
 * commands returned { ok, text } and the write commands returned
 * { code, stdout, stderr }. They said the same thing twice, so this is the
 * single type, with both vocabularies on it and no way for them to disagree:
 * `text` is always the whole output, and the stream/exit-code fields are
 * derived from `ok` at construction. Build one with ok()/failed()/rejected()
 * and never by hand — a literal is how the two drift again.
 *
 * Returned rather than printed so tests assert the exact bytes an agent reads,
 * and so the MCP tools can reuse a command body without capturing a stream.
 */
export interface CommandOutput {
  /** Did the command do what was asked? */
  ok: boolean;
  /** Exit code: 0 when ok, 1 otherwise (spec §4.2). */
  code: 0 | 1;
  /** The output when ok; empty otherwise. */
  stdout: string;
  /** The output when not ok; empty otherwise — agents read stderr. */
  stderr: string;
  /** The output text either way, which is what the MCP surface returns. */
  text: string;
}

/** Historical name for CommandOutput, kept so `get`/`check`/`rules`/`view` read naturally. */
export type CommandResult = CommandOutput;

/** The one constructor. `ok` decides the stream and the exit code, once. */
function output(succeeded: boolean, text: string): CommandOutput {
  return {
    ok: succeeded,
    code: succeeded ? 0 : 1,
    stdout: succeeded ? text : '',
    stderr: succeeded ? '' : text,
    text,
  };
}

/** A success: the text on stdout, exit 0. */
export function ok(text: string): CommandOutput {
  return output(true, text);
}

/** A failure whose text is already rendered (a read failure, an invalid document). */
export function failed(text: string): CommandOutput {
  return output(false, text);
}

/** A rejection: the errors framed by renderRejection, on stderr, exit 1. */
export function rejected(errors: string[]): CommandOutput {
  return output(false, renderRejection(errors));
}

/** A rejection from a command that never touches the document (see renderRefusal). */
export function rejectedRead(errors: string[]): CommandOutput {
  return output(false, renderRefusal('rejected — nothing written', errors));
}

/**
 * Write a command's output to the real streams and set the exit code.
 *
 * `process.exitCode` rather than `process.exit()`: exit() can truncate a
 * pending stdout write on a pipe, and the whole point of this surface is that
 * the agent gets to read the text.
 */
export function emit(out: CommandOutput): void {
  if (out.stdout !== '') process.stdout.write(`${out.stdout}\n`);
  if (out.stderr !== '') process.stderr.write(`${out.stderr}\n`);
  if (out.code !== 0) process.exitCode = out.code;
}

/**
 * `cannot read <path>` plus the parse/validation messages, indented the same
 * two spaces as a rejection: one failure shape for the agent to parse, whether
 * the problem is the patch it sent or the file it hand-edited (spec §4.3).
 */
export function renderReadFailure(graphFile: string, errors: string[]): string {
  return [`cannot read ${graphFile}`, ...errors.map((e) => `  ${e}`)].join('\n');
}
