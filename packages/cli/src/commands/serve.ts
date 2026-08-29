// commands/serve.ts — `diagram serve` (spec §9, M5 Step 14).
//
// Wires the three pieces:
//   1. a static http server for the prebuilt viewer bundle (serve/http.ts),
//   2. the graph.json watcher + WebSocket broadcast (serve/watch.ts),
//   3. the browser, opened once via child_process (no `open` dependency).
//
// The .diagram/ directory is created on demand and seeded with an empty but
// valid graph.json, so a fresh project shows an empty canvas instead of an
// error and the watcher has a real file to watch.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Runtime import of core by relative path (not '@diagram-engine/core'):
// core is consumed as TS source in the workspace, and the CLI build compiles
// core's src alongside its own (see tsconfig.build.json), so a relative
// specifier resolves both from src/ (vitest/typecheck) and from dist/.
import {
  diagramPaths,
  emptyDoc,
  writeDocAtomic,
} from '../../../core/src/index.js';
import { createContext } from './context.js';
import { startHttpServer, type StaticServer } from '../serve/http.js';
import { attachDocSync, type DocSync } from '../serve/watch.js';

export interface ServeOptions {
  /** Requested port; default 4400, auto-incremented on EADDRINUSE (§9). */
  port?: number;
  /** Open a browser tab on start. Default true; `--no-open` sets false (§9). */
  open?: boolean;
  /** .diagram/ directory. Default: DIAGRAM_DIR env, else <cwd>/.diagram. */
  dir?: string;
  /** Static asset root. Default: the prebuilt bundle in cli/dist/public. */
  publicDir?: string;
}

export interface ServeHandle {
  /** The bound port (after any EADDRINUSE increments). */
  port: number;
  /** Always 127.0.0.1 — never 0.0.0.0 (§9). */
  host: string;
  /** URL handed to the browser. */
  url: string;
  /** The resolved .diagram/ directory. */
  dir: string;
  http: StaticServer;
  sync: DocSync;
  close(): Promise<void>;
}

/**
 * Create the .diagram/ directory if missing and seed graph.json with an
 * empty, schema-valid document when there is nothing there yet.
 */
export function ensureDiagramDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const p = diagramPaths(dir);
  if (!fs.existsSync(p.graphFile)) writeDocAtomic(dir, emptyDoc());
}

/**
 * Open a URL in the user's default browser using node built-ins only
 * (no `open` dependency). Best effort: a failure to launch never takes
 * the server down — the URL is already printed to the terminal.
 */
export function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      // `start` is a cmd.exe builtin; the empty string is the window title
      // argument, which start would otherwise take from a quoted URL.
      command = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    default:
      command = 'xdg-open';
      args = [url];
      break;
  }
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no browser on this box — the printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

/**
 * Start the viewer server: static assets + live document sync.
 * Returns a handle so tests (and future callers) can shut it down.
 */
export async function runServe(opts: ServeOptions = {}): Promise<ServeHandle> {
  // Same resolution as every other command (createContext): an explicit
  // --dir, then $DIAGRAM_DIR, then an existing .diagram/ at or above the
  // working directory. Serving from a subdirectory used to create a second,
  // empty document and render a blank page beside the real diagram.
  const dir = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) }).dir;
  ensureDiagramDir(dir);

  const httpServer = await startHttpServer({
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.publicDir !== undefined ? { publicDir: opts.publicDir } : {}),
  });
  const sync = attachDocSync(httpServer.server, dir);
  // Do not announce the server before the file watch is live: a patch
  // written in that window would otherwise be missed by every client.
  await sync.ready;

  // localhost (not 127.0.0.1) in the browser URL: same address, friendlier
  // in the address bar. The socket itself is bound to 127.0.0.1 only.
  const url = `http://localhost:${httpServer.port}/`;
  if (opts.open !== false) openBrowser(url);

  return {
    port: httpServer.port,
    host: httpServer.host,
    url,
    dir,
    http: httpServer,
    sync,
    close: async () => {
      await sync.close();
      await httpServer.close();
    },
  };
}

/** The `diagram serve` command body: start, print, and stay up. */
export async function serveCommand(opts: ServeOptions = {}): Promise<ServeHandle> {
  const handle = await runServe(opts);
  process.stdout.write(
    `diagram serve\n` +
      `  viewer   ${handle.url}\n` +
      `  document ${path.join(handle.dir, 'graph.json')}\n` +
      `  bound to ${handle.host} only — press Ctrl+C to stop\n`,
  );
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
