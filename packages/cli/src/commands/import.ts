// commands/import.ts — `diagram import --file arch.json | --stdin` (spec §4.2, §2.5, §4.3).
//
// The other half of `diagram export json`: read a whole GraphDoc back in and
// make it the document. It is how a diagram moves between projects, how a
// generator hands its output to the engine, and how a human who hand-edited
// the JSON gets it validated instead of discovering the problem when the
// viewer goes blank (spec §4.3, path C).
//
// THIS IS NOT A PATCH, and the difference is the whole design:
//
//   * a patch EDITS — it names ops and everything unnamed survives;
//   * an import REPLACES — every node, group and edge that is not in the
//     incoming file is gone.
//
// So it is the one command besides `diagram reset` that can destroy a session's
// work in a single turn, and it carries reset's guard, spelled the same way:
// --confirm. Deliberately NOT required when the standing document is empty —
// `diagram import` into a fresh project is the ordinary first move and a
// confirmation there is a speed bump that teaches an agent to pass --confirm
// reflexively, which is exactly how the guard stops working when it matters.
//
// Three safety properties, all of them the same ones every other write has:
//   - it goes through the exclusive .lock, so an import racing a patch cannot
//     interleave into a half-replaced document;
//   - it snapshots history first, so `diagram undo` puts the old diagram
//     straight back — nothing here is unrecoverable;
//   - it validates the incoming document with the SAME zod schema and the
//     SAME V1–V13 invariants a patch is held to, before anything is written,
//     and reports failures in the same terse rejection shape. An import can
//     no more create an invalid document than a patch can.
//
// Geometry stays impossible: GraphDocSchema strips nothing but also permits
// nothing extra (§1.4's deny-list lives inside the schema and the invariants),
// so an incoming file carrying x/y is rejected rather than quietly persisted.
//
// No MCP tool. Spec §4.1 fixes the agent surface at seven tools and an agent
// that can call diagram_patch has no need to replace a document wholesale;
// import is a HUMAN/pipeline operation, which is what the CLI is for (§4.2).
//
// Runtime import of core by relative path: see the note in commands/patch.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import {
  GraphDocSchema,
  formatIssues,
  readDoc,
  snapshotHistory,
  validate,
  withLock,
  writeDocAtomic,
  type GraphDoc,
} from '../../../core/src/index.js';
import {
  createContext,
  emit,
  ok,
  rejected,
  renderCounts,
  renderStaleCollapsedLine,
  type CommandOutput,
  type ContextOptions,
  type DiagramContext,
} from './context.js';
import { readStream } from './patch.js';

export interface ImportOptions extends ContextOptions {
  /** Read the document from stdin (the default). */
  stdin?: boolean;
  /** Read the document from this file instead. */
  file?: string;
  /** Required when the standing diagram is not empty. */
  confirm?: boolean;
}

/** Parsing an incoming document: the document, or the lines that fix the text. */
export type ParseDocResult =
  | { ok: true; doc: GraphDoc }
  | { ok: false; errors: string[] };

/**
 * The shape reminder appended to every "this is not a document" message. The
 * closing clause is the important half: the commonest way this command is
 * misused is an agent sending a PATCH to it, and the error has to name the
 * command it actually wanted.
 */
const DOC_SHAPE =
  'expected a whole document: {"schemaVersion":1,"title":"...","direction":"DOWN",' +
  '"nodes":[],"groups":[],"edges":[],"collapsed":[]} ' +
  '— to change part of a diagram use `diagram patch`, which takes {"summary":...,"ops":[...]}';

/**
 * Turn raw text into a validated GraphDoc, or into error lines.
 *
 * `source` names where the text came from ("stdin", or the file path) so the
 * agent knows which input to fix. The four failure modes stay apart because
 * they have four different fixes: you sent nothing / that is not JSON / that
 * is JSON but not a document / that is a document but not a legal one.
 */
export function parseDocText(raw: string, source: string): ParseDocResult {
  if (raw.trim() === '') {
    return { ok: false, errors: [`${source}: no document text — ${DOC_SHAPE}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [`${source}: not valid JSON: ${(e as Error).message}`, `  ${DOC_SHAPE}`],
    };
  }

  const result = GraphDocSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: [`${source}: not a valid diagram document`, ...formatIssues(result.error.issues), `  ${DOC_SHAPE}`],
    };
  }

  // The schema says the SHAPE is right; the invariants say the diagram is
  // coherent (V1–V13: ids, parents, endpoints, budgets, ERD rules). Both, in
  // that order, because a validate() over a mis-shaped object is meaningless.
  const invariants = validate(result.data);
  if (!invariants.ok) {
    return { ok: false, errors: [`${source}: invalid diagram`, ...invariants.errors] };
  }
  return { ok: true, doc: result.data };
}

/** Is there anything in this document to lose? */
function isEmpty(doc: GraphDoc): boolean {
  return doc.nodes.length === 0 && doc.groups.length === 0 && doc.edges.length === 0;
}

/**
 * Replace the document under the lock.
 *
 * The standing document is read INSIDE the lock and the --confirm decision is
 * made from that read, not from one taken before it: a patch landing in the
 * gap would otherwise turn "the diagram is empty, no confirmation needed"
 * into a silent overwrite of somebody's eleven nodes.
 *
 * A standing document that cannot be PARSED is not a reason to refuse. It is
 * the strongest reason to import: a hand-corrupted graph.json is precisely
 * what §4.3 path C leaves the user holding, and the replacement is valid. It
 * still needs --confirm, because the bytes are recoverable from history and
 * the user may not have meant to discard them.
 */
export function importDoc(
  ctx: DiagramContext,
  doc: GraphDoc,
  confirm: boolean,
): CommandOutput {
  return withLock(ctx.dir, (): CommandOutput => {
    const current = readDoc(ctx.paths.graphFile);
    const existed = fs.existsSync(ctx.paths.graphFile);
    const standing = current.ok ? current.doc : undefined;
    const broken = existed && !current.ok;
    const occupied = broken || (standing !== undefined && existed && !isEmpty(standing));

    if (occupied && !confirm) {
      const what =
        standing !== undefined ? renderCounts(standing) : 'a document that no longer parses';
      return rejected([
        `import REPLACES the whole diagram — ${what} would be discarded`,
        `the incoming document has ${renderCounts(doc)}`,
        're-run with --confirm if that is what you want (`diagram undo` restores the old one)',
      ]);
    }

    // snapshotHistory reads the pre-import graph.json to seed snapshot 0000,
    // so it must run before the write — that seed is what undo restores.
    snapshotHistory(ctx.dir, doc);
    writeDocAtomic(ctx.dir, doc);

    const replaced =
      !existed || standing === undefined
        ? broken
          ? 'a document that no longer parsed'
          : 'nothing — there was no diagram here'
        : isEmpty(standing)
          ? 'nothing — the diagram was empty'
          : renderCounts(standing);

    // A `collapsed` entry naming a node or a deleted group is not invalid —
    // it is simply ignored when drawing — but this is the moment the agent
    // can still fix it, so say so rather than letting it surface in an export.
    const stale = renderStaleCollapsedLine(doc);
    return ok(
      [
        `ok — imported ${JSON.stringify(doc.title)} (\`diagram undo\` restores the previous diagram)`,
        `replaced: ${replaced}`,
        `graph: ${renderCounts(doc)}`,
        ...(stale === null ? [] : [stale]),
      ].join('\n'),
    );
  });
}

/**
 * Import an already-obtained document text — the whole command body minus the
 * reading of stdin, so tests can drive it synchronously.
 */
export function runImportText(
  raw: string,
  source: string,
  opts: ImportOptions = {},
): CommandOutput {
  const parsed = parseDocText(raw, source);
  if (!parsed.ok) return rejected(parsed.errors);

  const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  return importDoc(ctx, parsed.doc, opts.confirm === true);
}

/**
 * `diagram import`: resolve the input source, then replace.
 *
 * --file wins over --stdin when both are given (an explicit path is the more
 * specific instruction); with neither, stdin is the default, so
 * `diagram export json --out - | ...`-style pipelines and a heredoc both
 * work. Exactly the precedence `diagram patch` uses — two commands that read
 * JSON from the same two places must read it the same way.
 */
export async function runImport(
  opts: ImportOptions = {},
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<CommandOutput> {
  const rest: ImportOptions = {
    ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
    ...(opts.confirm !== undefined ? { confirm: opts.confirm } : {}),
  };

  if (opts.file !== undefined && opts.file !== '') {
    const file = path.resolve(opts.file);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return rejected([`--file ${opts.file}: ${(e as NodeJS.ErrnoException).message}`]);
    }
    return runImportText(raw, file, rest);
  }

  return runImportText(await readStream(stdin), 'stdin', rest);
}

/** Register `diagram import` on the program. The integrator calls this. */
export function registerImport(program: Command): void {
  program
    .command('import')
    .description('replace the whole diagram with a JSON document from stdin or a file')
    .option('--stdin', 'read the document from stdin (the default)')
    .option('--file <path>', 'read the document from this file instead of stdin')
    .option('--confirm', 'confirm the standing diagram may be replaced (undoable)')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action(async (opts: { stdin?: boolean; file?: string; confirm?: boolean; dir?: string }) => {
      emit(
        await runImport({
          ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
          ...(opts.file !== undefined ? { file: opts.file } : {}),
          ...(opts.confirm !== undefined ? { confirm: opts.confirm } : {}),
          ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        }),
      );
    });
}
