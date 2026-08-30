#!/usr/bin/env node
// bin/diagram.ts — the `diagram` binary (spec §4.2, M5 Step 14 / M6 Step 15).
//
// The whole CLI surface, registered in one place. Every command lives in its
// own src/commands/<name>.ts module and registers itself, so this file is a
// table of contents and nothing else: no argument parsing, no I/O, no wording.
// That matters because the same command bodies back the MCP tools — if the
// logic lived here, the two surfaces would drift the moment either changed.
//
// One vocabulary across the whole table: `--dir <path>` is always the
// .diagram/ directory, defaulting to $DIAGRAM_DIR or ./.diagram. The single
// exception is `init`, which installs across the whole project and therefore
// takes `--root` — a different name, deliberately, because the same flag
// meaning two different directories is the kind of thing nobody notices until
// they have written into the wrong one.

import { Command } from 'commander';
import { CLI_VERSION } from '../index.js';
import { serveCommand } from '../commands/serve.js';
import { registerInit } from '../commands/init.js';
import { registerGet } from '../commands/get.js';
import { registerPatch } from '../commands/patch.js';
import { registerUndo } from '../commands/undo.js';
import { registerRedo } from '../commands/redo.js';
import { registerView } from '../commands/view.js';
import { registerExport } from '../commands/export.js';
import { registerImport } from '../commands/import.js';
import { registerCheck } from '../commands/check.js';
import { registerAnalyse } from '../commands/analyse.js';
import { registerBlastRadius } from '../commands/blastRadius.js';
import { registerRules } from '../commands/rules.js';
import { registerReset } from '../commands/reset.js';
import { registerMcp } from '../mcp/server.js';

/** Parse a --port value; commander hands us the raw string. */
function parsePort(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer 0-65535, got "${raw}"`);
  }
  return n;
}

/** Register `diagram serve` — the M5 command, unchanged. */
function registerServe(program: Command): void {
  program
    .command('serve')
    .description('serve the viewer and live-reload it from .diagram/graph.json')
    .option('--port <n>', 'port to listen on (default 4400, auto-increments)', parsePort)
    .option('--no-open', 'do not open a browser tab')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action(async (opts: { port?: number; open?: boolean; dir?: string }) => {
      await serveCommand({
        ...(opts.port !== undefined ? { port: opts.port } : {}),
        ...(opts.open !== undefined ? { open: opts.open } : {}),
        ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
      });
      // serveCommand keeps the process alive via its open server handles.
    });
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('diagram')
    .description('Prompt-driven architecture diagramming engine — local, no API keys')
    .version(CLI_VERSION);

  // Registration order is the order `diagram --help` lists them, so it runs
  // in the order an agent meets them: set up, read, write, history, view,
  // output, verify, reason, learn — and reset last, where a destructive
  // command belongs. `import` sits next to `export` because it is the other
  // half of the same file pair, and reading them apart is how you end up with
  // two vocabularies for one round trip.
  //
  // `analyse` and `blast-radius` come after `check` and before `rules`: they
  // are the reasoning pair (Parts 15 and 18), and they only make sense once
  // the document is known to be valid. `analyse` is first because it is what
  // raises the question `blast-radius` answers — a chokepoint is where you
  // point a prediction — and reading them the other way round teaches an
  // agent to predict before it knows where to look.
  registerInit(program);
  registerGet(program);
  registerPatch(program);
  registerUndo(program);
  registerRedo(program);
  registerView(program);
  registerServe(program);
  registerExport(program);
  registerImport(program);
  registerCheck(program);
  registerAnalyse(program);
  registerBlastRadius(program);
  registerRules(program);
  registerMcp(program);
  registerReset(program);

  return program;
}

// Only run when executed as a binary, never on import (tests import this).
// The regex is anchored so it cannot also match the diagram-mcp entry point.
const invokedDirectly =
  process.argv[1] !== undefined &&
  /[\\/]diagram(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  buildProgram().parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(`diagram: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
