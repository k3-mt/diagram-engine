// serve/watch.ts — graph.json watcher + SSE broadcast (spec §9, M5; §16.3).
//
// Exactly the §9 shape, with two dependencies removed (§16.3):
//
//   chokidar → fs.watch. §9 watches exactly ONE file, and chokidar was the
//   only reason a NATIVE binary (fsevents) was in the tree — which is not
//   merely a review burden: esbuild cannot inline a .node file, so a bundled,
//   lockfile-free plugin artifact (§16.2) is impossible while it is there.
//
//   ws → Server-Sent Events. Look at what this module actually does: it
//   pushes {type:'doc'} and {type:'error'} to the browser and the browser
//   sends nothing back. That is not a WebSocket use case. EventSource is
//   built into the browser, so the client dependency is zero, and it
//   RECONNECTS NATIVELY — which deletes most of the hand-rolled reconnecting
//   client. A simplification, not a trade.
//
// The behaviour §9 specifies is unchanged:
// - A half-written file must never be read. chokidar's awaitWriteFinish is
//   replaced by a short debounce (WRITE_SETTLE_MS) on the same reasoning.
// - Invalid file → NO repaint. The last good diagram stays on screen; the
//   errors go to .diagram/errors.txt for file-protocol agents (§9: never
//   blank the canvas on a parse error).
// - Invalid file ALSO → {type:'error', errors} to the clients, so the
//   status bar can flash amber (§9). Without it the user sees a green
//   "connected" dot over a stale diagram and no sign their last patch was
//   rejected — the exact confusion §8.4's dot exists to prevent. This
//   frame carries no doc, so it can never repaint or blank the canvas.
// - Every newly connected client is sent the current doc immediately.
//
// WHY THE DIRECTORY IS WATCHED, NOT THE FILE. Writes are atomic (tmp +
// rename, store/write.ts), so an inode watch on graph.json goes deaf the
// moment the first patch lands — it would keep watching a file nobody writes
// to again. Watching .diagram/ and filtering by name survives rename, unlink
// and the file not existing yet, which is also what let chokidar's 'add'
// handler go away.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
// Runtime import of core by relative path (not '@diagram-engine/core'):
// core is consumed as TS source in the workspace, and the CLI build compiles
// core's src alongside its own (see tsconfig.build.json) — a relative
// specifier resolves both from src/ (vitest/typecheck) and from dist/.
import { diagramPaths, readDoc, type GraphDoc } from '../../../core/src/index.js';

/**
 * Where the viewer subscribes. Namespaced under /__diagram/ alongside the
 * identity endpoint (§9.1) so it can never collide with a static asset.
 */
export const EVENTS_PATH = '/__diagram/events';

/**
 * How long a write must be quiet before it is read (was chokidar's
 * awaitWriteFinish stabilityThreshold). A rename is atomic and needs none of
 * this; the debounce is here for the editor or agent that writes in place,
 * and for coalescing the burst of events one save can produce.
 */
export const WRITE_SETTLE_MS = 40;

/**
 * Told to the browser as its reconnect delay. EventSource honours this and
 * does the backoff itself — the entire dial/backoff state machine that the
 * WebSocket client carried is now these two words on the wire.
 */
const RETRY_MS = 500;

/** The repaint message pushed to viewer clients (§9). */
export interface DocMessage {
  type: 'doc';
  doc: GraphDoc;
  /**
   * The project root a repo-relative binding ref resolves against (§3.8) — the
   * parent of the .diagram directory, the same root `diagram check --bindings`
   * defaults to. The viewer cannot work it out (it only ever sees the
   * document), and without it a binding chip in the hover panel has no file to
   * open (P5-03). It says where the served project IS; it is not a claim about
   * a running system, and nothing is written back into the document (R5).
   */
  root: string;
}

/**
 * Sent instead of a doc when graph.json fails to parse or validate (§9).
 * Deliberately carries no doc: the viewer keeps the last good diagram and
 * only flashes the status bar amber.
 */
export interface ErrorMessage {
  type: 'error';
  errors: string[];
}

export type ServerMessage = DocMessage | ErrorMessage;

export interface DocSync {
  /**
   * Resolves once the watch is live. Until then a write to graph.json can be
   * missed entirely, so `diagram serve` waits for this before announcing the
   * URL. fs.watch is established synchronously (chokidar's asynchronous
   * initial scan is what made this a promise), but the contract is kept: the
   * caller should not have to know which watcher is underneath.
   */
  ready: Promise<void>;
  /** Number of currently connected clients (for tests / status). */
  clientCount(): number;
  /**
   * Answer the SSE subscription. Returns false for any other request, so the
   * static handler can deal with it.
   *
   * This is the shape WebSockets could not have: an upgrade handler must be
   * attached to a live http.Server, which coupled the watcher's construction
   * to the server's. An SSE route is just a request handler, so the sync can
   * be built before anything is listening.
   */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  close(): Promise<void>;
}

/** One subscribed browser. */
interface Client {
  res: http.ServerResponse;
}

/** Encode one message as an SSE frame. */
export function sseFrame(msg: ServerMessage): string {
  // JSON.stringify never emits a raw newline inside a string, so the payload
  // is always exactly one `data:` line — no multi-line framing needed.
  return `data: ${JSON.stringify(msg)}\n\n`;
}

/** Send a message to every connected client. */
export function broadcast(clients: Set<Client>, msg: ServerMessage): void {
  const frame = sseFrame(msg);
  for (const c of clients) {
    // A client that has gone away throws on write; the 'close' handler will
    // remove it, so swallowing here only avoids taking the server down with
    // a browser tab.
    try {
      c.res.write(frame);
    } catch {
      /* dropped client */
    }
  }
}

/**
 * Build the document watcher + SSE broadcast for a .diagram directory.
 *
 * - New client subscribes → the current doc is read (zod-validated) and sent
 *   to that client immediately.
 * - graph.json changes → re-read; valid → broadcast {type:'doc', doc} to
 *   all clients; invalid → write the errors to .diagram/errors.txt and
 *   broadcast an error frame.
 */
export function createDocSync(dir: string): DocSync {
  const p = diagramPaths(dir);
  const graphName = path.basename(p.graphFile);
  const clients = new Set<Client>();

  /** Send one message to a single client, or to all when no target. */
  const deliver = (msg: ServerMessage, target?: Client): void => {
    if (target !== undefined) {
      try {
        target.res.write(sseFrame(msg));
      } catch {
        /* dropped client */
      }
    } else {
      broadcast(clients, msg);
    }
  };

  /** Read + validate; deliver to one client or broadcast to all. */
  const publish = (target?: Client): void => {
    const r = readDoc(p.graphFile);
    if (!r.ok) {
      // Invalid → errors.txt for file-protocol agents, and an error frame
      // for the status bar. NO doc frame: the last good diagram stays on
      // screen — never blank the canvas on a parse error (§9).
      try {
        fs.writeFileSync(p.errorsFile, r.errors.join('\n') + '\n', 'utf8');
      } catch {
        // The dir vanished mid-serve; nothing useful to do.
      }
      deliver({ type: 'error', errors: r.errors }, target);
      return;
    }
    // Valid again: CLEAR errors.txt before repainting. The instructions
    // `diagram init` writes tell a file-protocol agent to read this file
    // straight after a hand edit (spec §4.3, path C), so a stale failure left
    // on disk tells that agent its correct edit is still broken and it loops
    // fixing an error that no longer exists.
    try {
      fs.rmSync(p.errorsFile, { force: true });
    } catch {
      // Read-only directory or a race with another writer; the repaint below
      // is still the truth, so nothing here is worth failing for.
    }
    deliver({ type: 'doc', doc: r.doc, root: path.dirname(path.resolve(p.dir)) }, target);
  };

  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const onFileEvent = (): void => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      publish();
    }, WRITE_SETTLE_MS);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(p.dir, (_event, filename) => {
      // filename is null on some platforms; with nothing to filter on, the
      // only safe reading is "something in .diagram/ changed" — publish and
      // let the debounce coalesce it.
      if (filename === null || path.basename(filename.toString()) === graphName) {
        onFileEvent();
      }
    });
    watcher.on('error', () => {
      /* the directory went away; nothing to repaint from */
    });
  } catch {
    // No watch (directory missing, or a platform that refuses). The server
    // still serves and still sends the current doc on subscribe — it just
    // will not push updates. Failing to start here would take the viewer
    // down over a degraded convenience.
  }

  return {
    ready: Promise.resolve(),
    clientCount: () => clients.size,
    handleRequest(req, res) {
      const url = req.url ?? '/';
      const pathname = (() => {
        try {
          return decodeURIComponent(new URL(url, 'http://localhost').pathname);
        } catch {
          return '';
        }
      })();
      if (pathname !== EVENTS_PATH) return false;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // A cached event stream is a stream that never updates.
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        // Node buffers small writes behind Nagle; a repaint that arrives
        // 40ms late because the packet was waiting for company is exactly
        // the latency this whole design exists to avoid.
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: ${RETRY_MS}\n\n`);

      const client: Client = { res };
      clients.add(client);
      const drop = (): void => {
        clients.delete(client);
      };
      req.on('close', drop);
      res.on('close', drop);
      res.on('error', drop);

      publish(client);
      return true;
    },
    close: async () => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      watcher?.close();
      for (const c of clients) {
        try {
          c.res.end();
        } catch {
          /* already gone */
        }
      }
      clients.clear();
      await Promise.resolve();
    },
  };
}
