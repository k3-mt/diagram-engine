// commands/undo.ts — `diagram undo` (spec §4.2, history in §2.5).
//
// One step back through .diagram/history: core's undoFromHistory moves the
// pointer and makes the earlier snapshot the current graph.json, under its
// own lock. Nothing here re-implements any of that.
//
// The only real design decision is the empty case. "Nothing to undo" is a
// normal thing for an agent to hit — it undoes speculatively — so it must
// read as an ordinary rejection with a next step, not as a crash. Exit 1
// still, because the requested change did not happen (spec §4.2).
//
// Runtime import of core by relative path: see the note in commands/patch.ts.

import type { Command } from 'commander';
import { undoFromHistory } from '../../../core/src/index.js';
import {
  autoServe,
  createContext,
  emit,
  loadDoc,
  ok,
  rejected,
  renderCounts,
  renderViewChangeLine,
  type CommandOutput,
  type ContextOptions,
  type ServeControl,
} from './context.js';

/**
 * Step the document back one history snapshot.
 *
 * The success text mirrors the patch shape — a headline saying what happened
 * plus the standing size line — so an agent parses one format, not five.
 */
export function runUndo(opts: ContextOptions = {}): CommandOutput {
  const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  // Read the document BEFORE the step, so the result can say what moved. A
  // view change moves no count, and the count line is what an agent reads to
  // confirm an undo did something (see renderViewChangeLine).
  const before = loadDoc(ctx);
  const result = undoFromHistory(ctx.dir);
  if (!result.ok) {
    // core says "nothing to undo" for both "no history at all" and "already
    // at the oldest snapshot"; the hint covers both without guessing which.
    const errors = result.errors.map((e) =>
      e === 'nothing to undo' ? 'nothing to undo — already at the oldest state' : e,
    );
    return rejected(errors);
  }
  const viewLine = before.ok ? renderViewChangeLine(before.doc, result.doc) : null;
  return ok(
    [
      'ok — undo',
      ...(viewLine === null ? [] : [viewLine]),
      `graph: ${renderCounts(result.doc)}`,
    ].join('\n'),
  );
}

/** Register `diagram undo` on the program. The integrator calls this. */
export function registerUndo(program: Command): void {
  program
    .command('undo')
    .description('step the document back one history snapshot')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .option('--no-serve', 'do not start the viewer if one is not already running')
    .action(async (opts: { dir?: string; serve?: boolean }) => {
      emit(
        await runUndoServing({
          ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
          ...(opts.serve === false ? { noServe: true } : {}),
        }),
      );
    });
}

/**
 * `diagram undo` plus the auto-serve hook (spec §9.1).
 *
 * undo IS a document-changing write, and it is one the user is
 * actively watching for — "put that back" is a request to SEE the diagram
 * without the last change. Where a patch that adds nodes is the case §9.1 was
 * written for, an undo that restores them is the same case running backwards,
 * so it is treated identically. The content gate in autoServe keeps the
 * degenerate direction quiet: an undo that lands on the empty document opens
 * no window, because there is nothing on it to look at.
 */
export async function runUndoServing(
  opts: ContextOptions & ServeControl = {},
): Promise<CommandOutput> {
  const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  const out = runUndo({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  // A successful step always moved the pointer — core refuses when there is
  // nowhere to go — so success is the change.
  return autoServe(out, ctx, out.ok, {
    ...(opts.noServe !== undefined ? { noServe: opts.noServe } : {}),
  });
}
