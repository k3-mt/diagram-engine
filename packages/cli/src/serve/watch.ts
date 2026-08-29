// serve/watch.ts — graph.json watcher + WebSocket broadcast (spec §9, M5).
//
// Exactly the §9 shape:
//
//   chokidar.watch(GRAPH_PATH, { awaitWriteFinish: { stabilityThreshold: 40 } })
//     .on('change', () => {
//       const r = readDoc(GRAPH_PATH);              // parse + zod validate
//       if (!r.ok) { fs.writeFileSync(ERRORS_PATH, r.errors.join('\n')); return; }
//       broadcast(wss, { type: 'doc', doc: r.doc });
//     });
//
// - awaitWriteFinish prevents reading a half-written file even with atomic
//   renames on some filesystems.
// - Invalid file → NO repaint. The last good diagram stays on screen; the
//   errors go to .diagram/errors.txt for file-protocol agents (§9: never
//   blank the canvas on a parse error).
// - Invalid file ALSO → {type:'error', errors} to the clients, so the
//   status bar can flash amber (§9). Without it the user sees a green
//   "connected" dot over a stale diagram and no sign their last patch was
//   rejected — the exact confusion §8.4's dot exists to prevent. This
//   frame carries no doc, so it can never repaint or blank the canvas.
// - Every newly connected client is sent the current doc immediately.

import * as fs from 'node:fs';
import type * as http from 'node:http';
import chokidar from 'chokidar';
import { WebSocketServer, WebSocket } from 'ws';
// Runtime import of core by relative path (not '@diagram-engine/core'):
// core is consumed as TS source in the workspace, and the CLI build compiles
// core's src alongside its own (see tsconfig.build.json) — a relative
// specifier resolves both from src/ (vitest/typecheck) and from dist/.
import { diagramPaths, readDoc, type GraphDoc } from '../../../core/src/index.js';

/** The repaint message pushed to viewer clients (§9). */
export interface DocMessage {
  type: 'doc';
  doc: GraphDoc;
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
  wss: WebSocketServer;
  /**
   * Resolves once chokidar's initial scan is done and the watch is live.
   * Until then a write to graph.json can be missed entirely, so `diagram
   * serve` waits for this before announcing the URL.
   */
  ready: Promise<void>;
  /** Number of currently connected clients (for tests / status). */
  clientCount(): number;
  close(): Promise<void>;
}

/** Send a message to every OPEN client. */
export function broadcast(wss: WebSocketServer, msg: ServerMessage): void {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  }
}

/**
 * Attach the document watcher + WebSocket broadcast to an http server.
 *
 * - New client connects → the current doc is read (zod-validated) and sent
 *   to that client immediately.
 * - graph.json changes → re-read; valid → broadcast {type:'doc', doc} to
 *   all clients; invalid → write the errors to .diagram/errors.txt and
 *   broadcast nothing.
 */
export function attachDocSync(server: http.Server, dir: string): DocSync {
  const p = diagramPaths(dir);
  const wss = new WebSocketServer({ server });

  /** Send one message to a single client, or to all when no target. */
  const deliver = (msg: ServerMessage, target?: WebSocket): void => {
    if (target !== undefined) {
      if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg));
    } else {
      broadcast(wss, msg);
    }
  };

  /** Read + validate; deliver to one client or broadcast to all. */
  const publish = (target?: WebSocket): void => {
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
    deliver({ type: 'doc', doc: r.doc }, target);
  };

  wss.on('connection', (ws) => publish(ws));

  let markReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const watcher = chokidar
    .watch(p.graphFile, { awaitWriteFinish: { stabilityThreshold: 40 } })
    .on('ready', () => {
      // The watch is live. Repaint once, in case the file changed during
      // the initial scan, then let the events do the work.
      publish();
      markReady();
    })
    .on('error', () => markReady())
    .on('change', () => publish())
    // Atomic tmp+rename can surface as unlink+add on some platforms, and the
    // file may not exist until the first patch lands — treat 'add' as a
    // change too. (The initial-scan 'add' broadcasts to zero clients.)
    .on('add', () => publish());

  return {
    wss,
    ready,
    clientCount: () => wss.clients.size,
    close: async () => {
      await watcher.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
