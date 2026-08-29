// tests/serve.test.ts — `diagram serve` over real sockets (spec §9, M5).
//
// Everything here is end-to-end: real http server on an ephemeral port, a
// real WebSocket client, a real temp .diagram/ directory, real atomic
// (tmp + rename) writes picked up by chokidar. No mocks.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { emptyDoc, diagramPaths, type GraphDoc } from '../../core/src/index.js';
import { startHttpServer, SERVE_HOST, contentTypeFor } from '../src/serve/http.js';
import { runServe, type ServeHandle } from '../src/commands/serve.js';

/** Things to tear down after each test, newest first. */
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A public dir containing one index.html. */
function fakePublicDir(body: string): string {
  const dir = tempDir('diagram-public-');
  fs.writeFileSync(path.join(dir, 'index.html'), body, 'utf8');
  return dir;
}

/** Start a server on an ephemeral port with a temp .diagram dir. */
async function startServe(publicDir?: string): Promise<ServeHandle> {
  const dir = path.join(tempDir('diagram-dir-'), '.diagram');
  const handle = await runServe({
    port: 0,
    open: false,
    dir,
    publicDir: publicDir ?? fakePublicDir('<!doctype html><title>viewer</title>'),
  });
  cleanups.push(() => handle.close());
  return handle;
}

/** Minimal GET helper (node http, no fetch polyfill assumptions). */
function get(port: number, urlPath: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: SERVE_HOST, port, path: urlPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const headers = res.headers['content-type'];
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          ...(typeof headers === 'string' ? { type: headers } : {}),
        });
      });
    });
    req.on('error', reject);
  });
}

/** Connect a ws client and collect every message it receives. */
async function connect(port: number): Promise<{ messages: unknown[]; ws: WebSocket; next(after: number, ms: number): Promise<unknown | undefined> }> {
  const ws = new WebSocket(`ws://${SERVE_HOST}:${port}`);
  const messages: unknown[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = async (after: number, ms: number): Promise<unknown | undefined> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (messages.length > after) return messages[after];
      await new Promise((r) => setTimeout(r, 20));
    }
    return undefined;
  };
  return { messages, ws, next };
}

/** Atomic write, exactly as the store does it (tmp + rename). */
function writeRaw(dir: string, raw: string): void {
  const p = diagramPaths(dir);
  fs.writeFileSync(p.graphTmpFile, raw, 'utf8');
  fs.renameSync(p.graphTmpFile, p.graphFile);
}

function docWith(title: string): GraphDoc {
  return { ...emptyDoc(), title };
}

describe('serve/http', () => {
  it('serves index.html with 200 from the public dir', async () => {
    const publicDir = fakePublicDir('<!doctype html><h1>hello viewer</h1>');
    const handle = await startServe(publicDir);
    const root = await get(handle.port, '/');
    expect(root.status).toBe(200);
    expect(root.body).toContain('hello viewer');
    expect(root.type).toContain('text/html');
    const explicit = await get(handle.port, '/index.html');
    expect(explicit.status).toBe(200);
  });

  it('404s anything else', async () => {
    const handle = await startServe();
    expect((await get(handle.port, '/nope.js')).status).toBe(404);
    expect((await get(handle.port, '/../secret.txt')).status).toBe(404);
  });

  it('maps the content types spec §9 needs', () => {
    expect(contentTypeFor('a.html')).toContain('text/html');
    expect(contentTypeFor('a.js')).toContain('javascript');
    expect(contentTypeFor('a.css')).toContain('text/css');
    expect(contentTypeFor('a.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('a.json')).toContain('application/json');
    expect(contentTypeFor('a.map')).toContain('application/json');
    expect(contentTypeFor('a.exe')).toBeUndefined();
  });

  it('binds 127.0.0.1, never 0.0.0.0', async () => {
    const handle = await startServe();
    const addr = handle.http.server.address();
    expect(addr).not.toBeNull();
    expect(typeof addr === 'object' ? addr?.address : '').toBe('127.0.0.1');
    expect(handle.host).toBe('127.0.0.1');
  });

  it('auto-increments the port on EADDRINUSE', async () => {
    // Grab a free port, then squat on it so the next listen fails.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, SERVE_HOST, r));
    const addr = probe.address();
    const taken = typeof addr === 'object' && addr !== null ? addr.port : 0;
    cleanups.push(() => new Promise<void>((r) => probe.close(() => r())));

    const server = await startHttpServer({ port: taken, publicDir: fakePublicDir('x') });
    cleanups.push(() => server.close());
    expect(server.port).toBe(taken + 1);
    expect(server.host).toBe('127.0.0.1');
  });
});

describe('serve/watch', () => {
  it('sends the current doc to a newly connected client', async () => {
    const handle = await startServe();
    writeRaw(handle.dir, JSON.stringify(docWith('on connect')));
    const client = await connect(handle.port);
    const msg = (await client.next(0, 3000)) as { type: string; doc: GraphDoc } | undefined;
    expect(msg).toBeDefined();
    expect(msg?.type).toBe('doc');
    expect(msg?.doc.title).toBe('on connect');
  });

  it('broadcasts a valid graph.json write to connected clients', async () => {
    const handle = await startServe();
    const client = await connect(handle.port);
    await client.next(0, 3000); // the on-connect doc
    const before = client.messages.length;

    writeRaw(handle.dir, JSON.stringify(docWith('after the patch')));

    const msg = (await client.next(before, 3000)) as { type: string; doc: GraphDoc } | undefined;
    expect(msg?.type).toBe('doc');
    expect(msg?.doc.title).toBe('after the patch');
  });

  it('writes errors.txt and sends an error frame — never a repaint — for invalid JSON', async () => {
    const handle = await startServe();
    const client = await connect(handle.port);
    await client.next(0, 3000);
    const before = client.messages.length;

    writeRaw(handle.dir, '{ this is not json');

    // §9: an error frame so the status bar can flash amber...
    const msg = (await client.next(before, 3000)) as
      | { type: string; errors?: string[]; doc?: unknown }
      | undefined;
    expect(msg?.type).toBe('error');
    expect(msg?.errors?.join('\n')).toMatch(/not valid JSON/);
    // ...carrying no doc, so the last good diagram cannot be repainted away.
    expect(msg?.doc).toBeUndefined();
    const since = client.messages.slice(before) as Array<{ type: string }>;
    expect(since.filter((m) => m.type === 'doc')).toEqual([]);

    const errorsFile = diagramPaths(handle.dir).errorsFile;
    expect(fs.existsSync(errorsFile)).toBe(true);
    expect(fs.readFileSync(errorsFile, 'utf8')).toMatch(/not valid JSON/);
  });

  it('removes errors.txt again once the document is valid (spec §4.3, path C)', async () => {
    // The CLAUDE.md that `diagram init` writes tells a file-protocol agent to
    // check errors.txt after a hand edit. Leaving a stale failure on disk tells
    // that agent its CORRECTED edit is still broken, and it loops fixing an
    // error that no longer exists.
    const handle = await startServe();
    const client = await connect(handle.port);
    await client.next(0, 3000);
    const errorsFile = diagramPaths(handle.dir).errorsFile;

    let before = client.messages.length;
    writeRaw(handle.dir, '{ this is not json');
    await client.next(before, 3000);
    expect(fs.existsSync(errorsFile)).toBe(true);

    before = client.messages.length;
    writeRaw(handle.dir, JSON.stringify(docWith('fixed again')));
    const msg = (await client.next(before, 3000)) as { type: string } | undefined;
    expect(msg?.type).toBe('doc');
    expect(fs.existsSync(errorsFile)).toBe(false);
  });

  it('writes errors.txt and sends an error frame for schema-invalid JSON too', async () => {
    const handle = await startServe();
    const client = await connect(handle.port);
    await client.next(0, 3000);
    const before = client.messages.length;

    writeRaw(handle.dir, JSON.stringify({ schemaVersion: 1, nodes: 'nope' }));

    const msg = (await client.next(before, 3000)) as
      | { type: string; errors?: string[] }
      | undefined;
    expect(msg?.type).toBe('error');
    expect(msg?.errors?.length).toBeGreaterThan(0);
    expect(fs.existsSync(diagramPaths(handle.dir).errorsFile)).toBe(true);
  });

  it('sends an error frame to a client that connects while graph.json is broken', async () => {
    const handle = await startServe();
    writeRaw(handle.dir, '{ nope');
    const client = await connect(handle.port);
    const msg = (await client.next(0, 3000)) as { type: string } | undefined;
    expect(msg?.type).toBe('error');
  });

  it('recovers: a valid write after a rejection broadcasts a doc again', async () => {
    const handle = await startServe();
    const client = await connect(handle.port);
    await client.next(0, 3000);

    const beforeError = client.messages.length;
    writeRaw(handle.dir, '{ broken');
    const err = (await client.next(beforeError, 3000)) as { type: string } | undefined;
    expect(err?.type).toBe('error');

    const afterError = client.messages.length;
    writeRaw(handle.dir, JSON.stringify(docWith('recovered')));
    const good = (await client.next(afterError, 3000)) as
      | { type: string; doc: GraphDoc }
      | undefined;
    expect(good?.type).toBe('doc');
    expect(good?.doc.title).toBe('recovered');
  });
});

describe('commands/serve', () => {
  it('creates .diagram and seeds a valid empty graph.json', async () => {
    const handle = await startServe();
    const p = diagramPaths(handle.dir);
    expect(fs.existsSync(p.dir)).toBe(true);
    expect(fs.existsSync(p.graphFile)).toBe(true);
    const doc = JSON.parse(fs.readFileSync(p.graphFile, 'utf8')) as GraphDoc;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.nodes).toEqual([]);
  });
});
