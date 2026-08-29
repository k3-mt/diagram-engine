// commands/redo.ts — `diagram redo` (spec §4.2, history in §2.5).
//
// The mirror of commands/undo.ts: core's redoFromHistory moves the pointer
// forward and makes that snapshot the current graph.json, under its own lock.
//
// Note the redo tail is discarded by the next commit (see snapshotHistory in
// core/store/write.ts), so "nothing to redo" is what an agent gets both at
// the newest snapshot and after undoing then patching. The message says the
// state, not the cause, because both have the same next step: patch forward.
//
// Runtime import of core by relative path: see the note in commands/patch.ts.

import type { Command } from 'commander';
import { redoFromHistory } from '../../../core/src/index.js';
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

/** Step the document forward one history snapshot. */
export function runRedo(opts: ContextOptions = {}): CommandOutput {
  const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  // Read the document BEFORE the step, so the result can say what moved. A
  // view change moves no count, and the count line is what an agent reads to
  // confirm an undo did something (see renderViewChangeLine).
  const before = loadDoc(ctx);
  const result = redoFromHistory(ctx.dir);
  if (!result.ok) {
    const errors = result.errors.map((e) =>
      e === 'nothing to redo' ? 'nothing to redo — already at the newest state' : e,
    );
    return rejected(errors);
  }
  const viewLine = before.ok ? renderViewChangeLine(before.doc, result.doc) : null;
  return ok(
    [
      'ok — redo',
      ...(viewLine === null ? [] : [viewLine]),
      `graph: ${renderCounts(result.doc)}`,
    ].join('\n'),
  );
}

/** Register `diagram redo` on the program. The integrator calls this. */
export function registerRedo(program: Command): void {
  program
    .command('redo')
    .description('step the document forward one history snapshot')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action((opts: { dir?: string }) => {
      emit(runRedo({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) }));
    });
}
