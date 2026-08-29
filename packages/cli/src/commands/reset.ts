// commands/reset.ts — `diagram reset --confirm` (spec §4.1 diagram_reset, §4.2).
//
// Throw the whole diagram away and start from the empty document. The guard
// is the point: an agent that fires reset instead of a patch destroys the
// user's work in one turn, so the command refuses without --confirm (the CLI
// twin of the MCP tool's required `{ confirm: true }`).
//
// Two safety properties beyond the flag:
//   - the reset IS a history snapshot, so `diagram undo` brings the diagram
//     straight back. Nothing is unrecoverable.
//   - the write happens under the same .lock as every patch, so a reset
//     racing a patch cannot interleave into a half-cleared document.
//
// This is the one write in the CLI that is not a GraphPatch, so it repeats
// what context.ts's applyAndCommit does (snapshotHistory then writeDocAtomic
// inside one lock) rather than routing through it: there is no patch to
// apply, and the .lock is not reentrant — calling core's commitDoc inside
// withLock would block for the full 2s stale timeout and then throw.
//
// Runtime import of core by relative path: see the note in commands/patch.ts.

import type { Command } from 'commander';
import {
  emptyDoc,
  snapshotHistory,
  withLock,
  writeDocAtomic,
} from '../../../core/src/index.js';
import {
  createContext,
  emit,
  ok,
  rejected,
  renderCounts,
  type CommandOutput,
  type ContextOptions,
} from './context.js';

export interface ResetOptions extends ContextOptions {
  /** Required. Without it the command refuses and changes nothing. */
  confirm?: boolean;
}

/** Clear the document back to the empty diagram. Requires `confirm`. */
export function runReset(opts: ResetOptions = {}): CommandOutput {
  if (opts.confirm !== true) {
    return rejected([
      'reset deletes every node, group and edge — re-run with --confirm',
    ]);
  }

  const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  const doc = emptyDoc();
  withLock(ctx.dir, () => {
    // snapshotHistory reads the pre-reset graph.json to seed snapshot 0000,
    // so it must run before the write — that seed is what undo restores.
    snapshotHistory(ctx.dir, doc);
    writeDocAtomic(ctx.dir, doc);
  });

  return ok(`ok — reset (\`diagram undo\` restores it)\ngraph: ${renderCounts(doc)}`);
}

/** Register `diagram reset` on the program. The integrator calls this. */
export function registerReset(program: Command): void {
  program
    .command('reset')
    .description('clear the diagram back to empty (requires --confirm; undoable)')
    .option('--confirm', 'confirm the diagram should be cleared')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action((opts: { confirm?: boolean; dir?: string }) => {
      emit(
        runReset({
          ...(opts.confirm !== undefined ? { confirm: opts.confirm } : {}),
          ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        }),
      );
    });
}
