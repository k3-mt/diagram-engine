// serve/http.ts — static file server for the viewer bundle (spec §9, M5).
//
// Serves the prebuilt viewer assets (built by packages/viewer into
// cli/dist/public, spec §2.4). Binds 127.0.0.1 ONLY — never 0.0.0.0 (§9).
// Default port 4400; on EADDRINUSE it auto-increments up to 10 ports past
// the requested one (4400 → 4410 for the default), then fails with a clear
// error (§9).

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only host we ever bind (§9). */
export const SERVE_HOST = '127.0.0.1';

/** Default viewer port (§9). */
export const DEFAULT_PORT = 4400;

/** How many EADDRINUSE increments to try past the requested port (§9: 4400→4410). */
export const PORT_ATTEMPTS = 10;

/** Extension → Content-Type. Anything not listed here is a 404. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Content type for a file path, or undefined when we refuse to serve it. */
export function contentTypeFor(filePath: string): string | undefined {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()];
}

/**
 * Resolve the default public dir (the prebuilt viewer bundle, §2.4).
 *
 * Two candidates, because this module runs from two places:
 * - compiled: dist/cli/src/serve/http.js → dist/public is ../../../public
 * - TS source (vitest / dev): packages/cli/src/serve/http.ts →
 *   packages/cli/dist/public is ../../dist/public
 *
 * The first candidate that exists wins; if neither exists yet (viewer not
 * built), the compiled-layout candidate is returned and requests 404.
 * NOTE: the integrate step (viewer build wiring) may adjust these candidates.
 */
export function defaultPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../public'), // from dist/cli/src/serve → dist/public
    path.resolve(here, '../../dist/public'), // from src/serve → cli/dist/public
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

export interface HttpServerOptions {
  /** Requested port. 0 = ephemeral (no auto-increment). Default 4400. */
  port?: number;
  /** Directory of prebuilt static assets. Default: defaultPublicDir(). */
  publicDir?: string;
}

export interface StaticServer {
  server: http.Server;
  /** The port actually bound (after any EADDRINUSE increments). */
  port: number;
  /** Always 127.0.0.1. */
  host: string;
  publicDir: string;
  close(): Promise<void>;
}

/** Map a request URL to a file inside publicDir, or undefined if it escapes. */
function resolveStaticFile(publicDir: string, url: string): string | undefined {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return undefined;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const resolved = path.resolve(publicDir, '.' + path.posix.normalize(pathname));
  // Containment check: never serve outside publicDir.
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
    return undefined;
  }
  return resolved;
}

function handleRequest(
  publicDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed\n');
    return;
  }
  const file = resolveStaticFile(publicDir, req.url ?? '/');
  const type = file === undefined ? undefined : contentTypeFor(file);
  if (file === undefined || type === undefined) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Try to listen on one host:port; resolves true, or false on EADDRINUSE. */
function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') resolve(false);
      else reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, SERVE_HOST);
  });
}

/**
 * Start the static server on 127.0.0.1. On EADDRINUSE the port is
 * incremented up to PORT_ATTEMPTS times (default request 4400 → last try
 * 4410, §9); if every port in that range is taken, throws a clear error.
 */
export async function startHttpServer(
  opts: HttpServerOptions = {},
): Promise<StaticServer> {
  const requested = opts.port ?? DEFAULT_PORT;
  const publicDir = path.resolve(opts.publicDir ?? defaultPublicDir());
  const server = http.createServer((req, res) => handleRequest(publicDir, req, res));

  const lastPort = requested === 0 ? 0 : requested + PORT_ATTEMPTS;
  for (let port = requested; port <= lastPort; port++) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    if (await tryListen(server, port)) {
      const addr = server.address();
      const bound =
        addr !== null && typeof addr === 'object' ? addr.port : port;
      return {
        server,
        port: bound,
        host: SERVE_HOST,
        publicDir,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      };
    }
    if (requested === 0) break; // ephemeral request can't be EADDRINUSE-retried
  }
  throw new Error(
    `every port from ${requested} to ${lastPort} is in use — ` +
      `pass --port to pick a free one`,
  );
}
