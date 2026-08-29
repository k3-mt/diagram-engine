#!/usr/bin/env node
// bin/diagram.ts — the `diagram` binary (spec §4.2, M5 Step 14).
//
// M5 ships exactly one command: `serve`. The rest of the CLI surface
// (get / patch / undo / redo / view / export / check / rules / init) is M6
// — see the TODO block at the bottom for the intended shape.

import { Command } from 'commander';
import { CLI_VERSION } from '../index.js';
import { serveCommand } from '../commands/serve.js';

/** Parse a --port value; commander hands us the raw string. */
function parsePort(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer 0-65535, got "${raw}"`);
  }
  return n;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('diagram')
    .description('Prompt-driven architecture diagramming engine — local, no API keys')
    .version(CLI_VERSION);

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

  // TODO(M6 — agent surface): register the remaining commands here, each in
  // its own src/commands/<name>.ts module, all sharing the same --dir
  // resolution as serve:
  //   program.command('init')            // .mcp.json, CLAUDE.md, AGENTS.md, skill
  //   program.command('get')             // print the compact table (§4.1)
  //   program.command('patch')           // read a GraphPatch as JSON on stdin
  //   program.command('undo')            // history pointer back
  //   program.command('redo')            // history pointer forward
  //   program.command('view <name>')     // derived view (§7)
  //   program.command('export')          // write .diagram/out.svg
  //   program.command('check')           // validate, exit non-zero on errors
  //   program.command('rules')           // cat core/src/rules.md (§4.4)

  return program;
}

// Only run when executed as a binary, never on import (tests import this).
const invokedDirectly =
  process.argv[1] !== undefined &&
  /[\\/]diagram(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  buildProgram().parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(`diagram: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
