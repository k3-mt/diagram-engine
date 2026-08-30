// commands/patch.ts — `diagram patch --stdin` / `--file ops.json` (spec §4.2).
//
// The CLI twin of the diagram_patch MCP tool, and the archetype for every
// other write command in this directory. It owns exactly three things:
//
//   1. getting the patch text (stdin or a file),
//   2. turning that text into a GraphPatch, or into an error an agent can
//      act on without re-reading the docs,
//   3. handing the patch to the shared spine in commands/context.ts.
//
// Everything after step 3 — the lock, the re-read, applyPatch, history, the
// atomic write, and the exact wording of the ok/rejected shapes — belongs to
// context.ts, so the CLI and the MCP tool cannot drift apart.
//
// Atomicity is the promise the agent relies on: a patch that is rejected for
// ANY reason (unreadable file, bad JSON, schema mismatch, failed invariant)
// leaves graph.json byte-identical. That is why parsing happens before the
// lock is ever taken, and why applyPatch validates the whole patch before it
// writes anything.
//
// Runtime import of core by relative path (not '@diagram-engine/core'): core
// is consumed as TS source in the workspace and the CLI build compiles core's
// src alongside its own (see tsconfig.build.json), so a relative specifier
// resolves both from src/ under vitest and from dist/ after a build.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import {
  GraphPatchSchema,
  formatIssues,
  type GraphPatch,
} from '../../../core/src/index.js';
import {
  applyAndCommit,
  autoServe,
  createContext,
  emit,
  failed,
  ok,
  rejected,
  renderPatchResult,
  type CommandOutput,
  type ContextOptions,
  type DiagramContext,
  type ServeControl,
} from './context.js';

export interface PatchOptions extends ContextOptions, ServeControl {
  /** Read the patch from stdin. */
  stdin?: boolean;
  /** Read the patch from this file instead. */
  file?: string;
}

/** Parsing a patch: the patch, or the lines that say how to fix the text. */
export type ParsePatchResult =
  | { ok: true; patch: GraphPatch }
  | { ok: false; errors: string[] };

/** The shape reminder appended to every "this is not a patch" message. */
const PATCH_SHAPE =
  'expected {"summary":"...","ops":[{"op":"addNode","node":' +
  '{"id":"web","type":"client","label":"Web app","parent":null}}]} ' +
  '— "summary" is required, and every node/group needs "parent" (null = top level)';

/**
 * Turn raw text into a GraphPatch, or into error lines.
 *
 * `source` names where the text came from ("stdin", or the file path) so the
 * agent knows which of the two inputs to fix. The three failure modes are
 * kept apart on purpose — "you sent nothing", "that is not JSON", and "that
 * is JSON but not a patch" have completely different fixes.
 */
export function parsePatchText(raw: string, source: string): ParsePatchResult {
  if (raw.trim() === '') {
    return { ok: false, errors: [`${source}: no patch text — ${PATCH_SHAPE}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [`${source}: not valid JSON: ${(e as Error).message}`, `  ${PATCH_SHAPE}`],
    };
  }

  const result = GraphPatchSchema.safeParse(parsed);
  if (!result.success) {
    // formatIssues gives "ops.0.op: <what to do>" lines — already the voice
    // the rest of the engine speaks, so they are passed straight through.
    // The shape reminder belongs here too, not only on the "not JSON" branch:
    // the commonest schema failure is a missing `summary` or a missing
    // `parent`, and the fix is visible the moment the whole shape is on screen.
    return {
      ok: false,
      errors: [
        `${source}: not a valid patch`,
        ...formatIssues(result.error.issues),
        `  ${PATCH_SHAPE}`,
      ],
    };
  }
  return { ok: true, patch: result.data };
}

/**
 * Read the whole of a stream as UTF-8 text. Defaults to process.stdin so the
 * command works with `diagram patch --stdin <<< '{...}'`; tests pass their
 * own Readable rather than mutating the process.
 */
export async function readStream(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Apply an already-obtained patch text against an already-resolved context,
 * and say whether the document MOVED.
 *
 * The `changed` half exists for auto-serve (spec §9.1 S1: a successful patch
 * that changed the document, never a rejected one). It is reported rather
 * than re-derived by the caller because only applyAndCommit sees both the
 * before and the after document.
 */
export function patchTextIn(
  ctx: DiagramContext,
  raw: string,
  source: string,
): { out: CommandOutput; changed: boolean } {
  const parsed = parsePatchText(raw, source);
  if (!parsed.ok) return { out: rejected(parsed.errors), changed: false };

  const result = applyAndCommit(ctx, parsed.patch);
  const text = renderPatchResult(result);
  return {
    out: result.ok ? ok(text) : failed(text),
    changed: result.ok && result.changed,
  };
}

/**
 * Apply an already-obtained patch text. The whole command body minus the
 * reading of stdin and the auto-serve hook, so tests can drive it
 * synchronously.
 */
export function runPatchText(
  raw: string,
  source: string,
  opts: ContextOptions = {},
): CommandOutput {
  const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  return patchTextIn(ctx, raw, source).out;
}

/**
 * `diagram patch` minus the stdin read: apply, then start a viewer if this
 * patch left content on the page and none is running (spec §9.1).
 */
export async function runPatchTextServing(
  raw: string,
  source: string,
  opts: PatchOptions = {},
): Promise<CommandOutput> {
  const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  const { out, changed } = patchTextIn(ctx, raw, source);
  return autoServe(out, ctx, changed, {
    ...(opts.noServe !== undefined ? { noServe: opts.noServe } : {}),
  });
}

/**
 * `diagram patch`: resolve the input source, then apply.
 *
 * --file wins over --stdin when both are given (an explicit path is the more
 * specific instruction); with neither, stdin is the default, which is what
 * `diagram patch <<< '{...}'` and a piped heredoc both look like.
 */
export async function runPatch(
  opts: PatchOptions = {},
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<CommandOutput> {
  const rest: PatchOptions = {
    ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
    ...(opts.noServe !== undefined ? { noServe: opts.noServe } : {}),
  };

  if (opts.file !== undefined && opts.file !== '') {
    const file = path.resolve(opts.file);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return rejected([`--file ${opts.file}: ${(e as NodeJS.ErrnoException).message}`]);
    }
    return runPatchTextServing(raw, file, rest);
  }

  return runPatchTextServing(await readStream(stdin), 'stdin', rest);
}

/** Register `diagram patch` on the program. The integrator calls this. */
export function registerPatch(program: Command): void {
  program
    .command('patch')
    .description('apply a GraphPatch read as JSON from stdin or a file')
    .option('--stdin', 'read the patch from stdin (the default)')
    .option('--file <path>', 'read the patch from this file instead of stdin')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    // commander turns `--no-serve` into `serve: false`, defaulting to true.
    .option('--no-serve', 'do not start the viewer if one is not already running')
    .action(async (opts: { stdin?: boolean; file?: string; dir?: string; serve?: boolean }) => {
      emit(
        await runPatch({
          ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
          ...(opts.file !== undefined ? { file: opts.file } : {}),
          ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
          ...(opts.serve === false ? { noServe: true } : {}),
        }),
      );
    });
}
