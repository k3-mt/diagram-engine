// store/paths.ts — .diagram/ directory resolution (spec §2.5).
//
// The on-disk layout is:
//   <project>/.diagram/
//   ├── graph.json           # the document — single source of truth
//   ├── history/
//   │   ├── 0000.json ... 0042.json
//   │   └── pointer          # plain integer
//   ├── errors.txt           # last validation failure, for file-protocol agents
//   └── out.svg              # written on `diagram export`
//
// The DIAGRAM_DIR environment variable overrides the location (this is how
// .mcp.json points the MCP server at "${workspaceFolder}/.diagram", spec §4.1).

import * as path from 'node:path';

/** Every path the store touches, resolved from one directory. */
export interface DiagramPaths {
  /** The .diagram/ directory itself. */
  dir: string;
  /** graph.json — the document, single source of truth. */
  graphFile: string;
  /** graph.json.tmp — staging file for the atomic tmp+rename write. */
  graphTmpFile: string;
  /** history/ — snapshot directory. */
  historyDir: string;
  /** history/pointer — plain integer, index of the current snapshot. */
  pointerFile: string;
  /** errors.txt — last validation failure, for file-protocol agents. */
  errorsFile: string;
  /** out.svg — written on `diagram export`. */
  svgFile: string;
  /** .lock — exclusive lock for the read-modify-write cycle. */
  lockFile: string;
}

/**
 * Resolve the .diagram/ directory: the DIAGRAM_DIR environment variable
 * wins when set (resolved against the current working directory if
 * relative); otherwise `<cwd>/.diagram`.
 */
export function resolveDiagramDir(cwd: string = process.cwd()): string {
  const env = process.env['DIAGRAM_DIR'];
  if (env !== undefined && env !== '') return path.resolve(cwd, env);
  return path.join(cwd, '.diagram');
}

/** All store paths for a given .diagram/ directory (default: resolved). */
export function diagramPaths(dir: string = resolveDiagramDir()): DiagramPaths {
  return {
    dir,
    graphFile: path.join(dir, 'graph.json'),
    graphTmpFile: path.join(dir, 'graph.json.tmp'),
    historyDir: path.join(dir, 'history'),
    pointerFile: path.join(dir, 'history', 'pointer'),
    errorsFile: path.join(dir, 'errors.txt'),
    svgFile: path.join(dir, 'out.svg'),
    lockFile: path.join(dir, '.lock'),
  };
}
