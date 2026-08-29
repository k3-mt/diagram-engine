// commands/check.ts — `diagram check` (spec §3.3, §4.2; M6 Step 15).
//
// Validates .diagram/graph.json and changes nothing. This is the command a
// CI step or a git hook runs, and the one an agent runs after hand-editing the
// file through the file protocol (spec Part 4) to find out whether what it
// wrote will be accepted before it asks anyone to look at it.
//
// Exit 0 and one line on stdout when the document is valid; exit 1 and the
// V1–V13 messages on stderr when it is not. The messages are core's verbatim —
// they are the contract the agent self-corrects from, so nothing here rewords
// them; this only frames them with a headline and a two-space indent, the same
// framing renderRejection uses, so one output shape covers every failure the
// agent sees.
//
// Runtime import of core by relative path — see commands/get.ts for why.

import type { Command } from 'commander';
import { validate } from '../../../core/src/index.js';
import {
  createContext,
  emit,
  failed,
  loadDoc,
  ok,
  renderCounts,
  renderReadFailure,
  renderStaleCollapsedLine,
  type CommandResult,
  type ContextOptions,
} from './context.js';

export type CheckOptions = ContextOptions;

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

/**
 * Validate the document on disk. Three outcomes, and they are genuinely
 * different: unreadable (bad JSON or wrong shape — the file cannot even be
 * loaded), readable but invalid (V1–V13), and valid. A document that does not
 * exist yet is valid: there is nothing wrong with a project nobody has drawn in.
 */
export function runCheck(opts: CheckOptions = {}): CommandResult {
  const ctx = createContext(opts);
  const loaded = loadDoc(ctx);
  if (!loaded.ok) {
    return failed(renderReadFailure(ctx.paths.graphFile, loaded.errors));
  }

  const result = validate(loaded.doc);
  if (!result.ok) return failed(renderInvalid(result.errors));

  const counts = renderCounts(loaded.doc);
  // There is no V-invariant for `collapsed` (it is presentation, not meaning),
  // so a stale id is a note under a passing check rather than a failure.
  const stale = renderStaleCollapsedLine(loaded.doc);
  return ok(
    [
      loaded.existed ? `ok — ${counts}` : `ok — no document yet at ${ctx.paths.graphFile}`,
      ...(stale === null ? [] : [stale]),
    ].join('\n'),
  );
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
    .action((opts: { dir?: string }) => {
      checkCommand({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
    });
}
