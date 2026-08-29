// @diagram-engine/cli — package entry point.
// M5: the viewer server (`diagram serve`). M6 adds the agent surface
// (commands/*, mcp/*).

export const CLI_PACKAGE = '@diagram-engine/cli';

/** Version reported by `diagram --version`; kept in step with package.json. */
export const CLI_VERSION = '0.0.0';

export * from './serve/http.js';
export * from './serve/watch.js';
export * from './commands/serve.js';
