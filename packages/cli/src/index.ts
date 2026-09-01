// @diagram-engine/cli — package entry point.
// M5: the viewer server (`diagram serve`). M6: the agent surface — the CLI
// commands, the shared spine they all run through, and the MCP stdio server.

export const CLI_PACKAGE = '@diagram-engine/cli';

/** Version reported by `diagram --version`; kept in step with package.json. */
export const CLI_VERSION = '0.1.0';

// M5 — the viewer server.
export * from './serve/http.js';
export * from './serve/watch.js';
export * from './commands/serve.js';

// M6 — the shared spine first: the .diagram/ context, the one write path, and
// the ok/rejected wording every surface below reuses.
export * from './commands/context.js';

// M6/M7 — the commands, in the order `diagram --help` lists them.
export * from './commands/init.js';
export * from './commands/get.js';
export * from './commands/patch.js';
export * from './commands/undo.js';
export * from './commands/redo.js';
export * from './commands/view.js';
export * from './commands/export.js';
export * from './commands/import.js';
export * from './commands/check.js';
// Part 15 / Part 18 — the reasoning pair, in the order `--help` lists them.
export * from './commands/analyse.js';
export * from './commands/blastRadius.js';
export * from './commands/rules.js';
export * from './commands/reset.js';

// M6 — the MCP server. Note bin/diagram-mcp.ts is NOT re-exported: importing
// an entry point that starts a stdio server is not something a library import
// should ever risk.
export * from './mcp/tools.js';
export * from './mcp/server.js';
