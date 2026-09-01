// layout/worker.ts — Web Worker wrapper for the layout pipeline (spec §5.4).
//
// Thin by design: ALL layout logic lives in runLayout.ts, so tests
// (Node) and the worker (browser) share one code path. Per §5.4 the
// SIZED ELK graph is built on the MAIN thread (LayoutClient.request
// runs toElk there, so §5.1's cached offscreen-canvas measureText
// executes where a canvas actually exists); the worker only runs ELK
// and flattens. Message plumbing:
//
//   main thread                    worker
//   -----------------------------  -------------------------------
//   toElk(doc) -> elkGraph
//   postMessage({id, graph: elkGraph})  ->  layoutElkGraph(graph)
//   onmessage(response)  <-  postMessage({id, ok, laidOut | error})
//
// Staleness: agents emit patches in bursts, and ELK runs are async, so
// responses can arrive after a newer request was already sent. The
// client tracks the latest requestId and DISCARDS any response with a
// different id — without this the canvas flickers between two layouts.
//
// The worker-scope wiring sits behind an explicit feature check
// (importScripts exists only in workers), so importing this module
// from Node or the main thread is a harmless no-op.

import type { GraphDoc } from '@diagram-engine/core';
import type { ElkNode } from 'elkjs';
import { layoutElkGraph, type ElkEngine } from './runLayout.js';
import { flowReversedEdgeIds } from './flow.js';
import { toElk } from './toElk.js';
import type { LaidOut } from './fromElk.js';

/**
 * Main thread -> worker (spec §5.4). `graph` is the SIZED ELK graph —
 * built by toElk on the main thread so node dimensions come from the
 * canvas-measured labels of §5.1, not the Node/worker fallback estimate.
 */
export interface LayoutRequest {
  id: number;
  graph: ElkNode;
  /**
   * Ids of the edges toElk handed to ELK with their endpoints swapped so
   * they would rank the far end first (§5.5, layout/flow.ts).
   *
   * It travels in the MESSAGE because the protocol sends the ELK graph, not
   * the document, and the swap cannot be recovered from the graph — a
   * reversed edge looks exactly like an edge that was authored that way. The
   * worker hands it to flatten, which puts the polylines back into document
   * order. Optional, so a message from before §5.5 still lays out (with no
   * edge reversed, which is what such a document meant).
   */
  flowReversed?: string[];
}

/** Worker -> main thread. */
export type LayoutResponse =
  | { id: number; ok: true; laidOut: LaidOut }
  | { id: number; ok: false; error: string };

/**
 * Handle one layout request. Pure async function (usable from Node
 * tests directly); errors are captured into the response rather than
 * thrown so a bad document cannot kill the worker.
 */
export async function handleLayoutRequest(
  req: LayoutRequest,
  elk?: ElkEngine,
): Promise<LayoutResponse> {
  try {
    return {
      id: req.id,
      ok: true,
      laidOut: await layoutElkGraph(
        req.graph,
        elk,
        req.flowReversed === undefined ? undefined : new Set(req.flowReversed),
      ),
    };
  } catch (err) {
    return {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Main-thread client: requestId tracking + stale-result discarding.

/** The subset of Worker the client needs (injectable for Node tests). */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

/**
 * Wraps the layout worker on the main-thread side. Each request(...)
 * bumps the requestId; only the response matching the LATEST id is
 * delivered — every stale response is silently discarded (spec §5.4).
 */
export class LayoutClient {
  private latestId = 0;

  constructor(
    private readonly worker: WorkerLike,
    private readonly onLayout: (laidOut: LaidOut) => void,
    private readonly onError?: (error: string) => void,
  ) {
    worker.addEventListener('message', (ev) => {
      const res = ev.data as LayoutResponse;
      if (res.id !== this.latestId) return; // stale — discard
      if (res.ok) this.onLayout(res.laidOut);
      else this.onError?.(res.error);
    });
  }

  /**
   * Request a layout of `doc`. Returns the requestId it was given.
   *
   * The sized ELK graph is built HERE, on the calling (main) thread,
   * before postMessage (spec §5.4): toElk -> sizeNode -> measureText
   * uses the cached offscreen canvas of §5.1, which only exists where
   * `document` does. Building it inside the worker would silently fall
   * back to the rough estimate and labels would overflow their boxes.
   */
  request(doc: GraphDoc): number {
    const id = ++this.latestId;
    const msg: LayoutRequest = {
      id,
      graph: toElk(doc),
      // Derived from the same document toElk just swapped, on this thread,
      // so the two can never disagree about which edges were reversed.
      flowReversed: [...flowReversedEdgeIds(doc)],
    };
    this.worker.postMessage(msg);
    return id;
  }
}

// ---------------------------------------------------------------------------
// Worker-scope wiring (browser only, behind an explicit feature check).

interface WorkerScopeLike {
  importScripts?: unknown;
  postMessage?: (msg: unknown) => void;
  onmessage?: ((ev: { data: unknown }) => void) | null;
}

const scope = globalThis as WorkerScopeLike;

// importScripts exists only in worker global scopes — not in Window,
// not in Node — so this is inert everywhere except a real worker.
if (
  typeof scope.importScripts === 'function' &&
  typeof scope.postMessage === 'function'
) {
  scope.onmessage = (ev) => {
    void handleLayoutRequest(ev.data as LayoutRequest).then((res) =>
      scope.postMessage!(res),
    );
  };
}
