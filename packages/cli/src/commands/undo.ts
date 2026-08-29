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
  createContext,
  emit,
  loadDoc,
  ok,
  rejected,
  renderCounts,
  renderViewChangeLine,
  type CommandOutput,
  type ContextOptions,
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
    .action((opts: { dir?: string }) => {
      emit(runUndo({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) }));
    });
}
