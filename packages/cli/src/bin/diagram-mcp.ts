#!/usr/bin/env node
// bin/diagram-mcp.ts — the `diagram-mcp` binary (spec §4.1, M6 Step 15).
//
// This is what .mcp.json launches. It speaks MCP over stdio and nothing else:
// no arguments to parse, no banner, no prompt. The .diagram/ directory comes
// from DIAGRAM_DIR (which is how .mcp.json points the server at the workspace)
// or ./.diagram, resolved per tool call by commands/context.ts.
//
// Nothing may be written to stdout here — stdout is the JSON-RPC channel and a
// single stray byte breaks the framing. Startup notes and fatal errors go to
// stderr via logStderr().
//
// The module runs the server only when it is executed as a binary, never on
// import, so tests can import it (and anything else can re-export it) without
// a server attaching itself to the test runner's stdin.

import { logStderr, startMcpServer, type McpServerHandle } from '../mcp/server.js';

/** Start the stdio server and wire the two signals that should stop it. */
export async function runMcp(): Promise<McpServerHandle> {
  const handle = await startMcpServer();
  const shutdown = (): void => {
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return handle;
}

// Only run when executed as a binary, never on import (tests import this).
const invokedDirectly =
  process.argv[1] !== undefined &&
  /[\\/]diagram-mcp(\.[cm]?[jt]s)?$/.test(process.argv[1]);
if (invokedDirectly) {
  runMcp().catch((err: unknown) => {
    logStderr((err as Error).message);
    process.exit(1);
  });
}
