// layout/runLayout.ts — the one shared layout code path (spec §5, M2).
//
// layout(doc) composes sizeNode/toElk (document -> measured ELK input),
// the real ELK layered layout, and flatten (relative ELK output ->
// absolute coordinates). Tests run it headless in Node; the worker
// (worker.ts) calls the exact same function in the browser, so there
// is exactly one code path to trust.
//
// ELK is instantiated from elkjs's BUNDLED build ('elkjs/lib/elk.bundled.js'):
// it runs the layout in-process with no worker/URL wiring, which works
// both under Node (vitest) and inside a Web Worker bundled by vite.
// (The default 'elkjs' entry tries to spawn its own web worker.)
//
// Pure async function, no DOM. The result is viewer-side geometry only
// and is NEVER written back to the document (spec §1.4/§3.1).

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs';
import type { GraphDoc } from '@diagram-engine/core';
import { toElk } from './toElk.js';
import { flatten, type LaidOut } from './fromElk.js';

// One engine instance, reused across calls.
const elk = new ELK();

/**
 * Lay out an ALREADY-SIZED ELK graph: ELK layered layout -> flattened
 * absolute geometry. This is the half that runs inside the worker
 * (spec §5.4): the sized graph is built on the MAIN thread by toElk,
 * so §5.1's cached offscreen-canvas text measurement actually runs
 * where a canvas exists.
 */
export async function layoutElkGraph(graph: ElkNode): Promise<LaidOut> {
  const laidOut = await elk.layout(graph);
  return flatten(laidOut);
}

/**
 * Lay out a document: GraphDoc -> sized ELK graph -> ELK layered
 * layout -> flattened absolute geometry. Single-thread convenience
 * (tests, Node); the browser path splits this across the §5.4
 * protocol boundary — toElk on the main thread, layoutElkGraph in
 * the worker.
 */
export async function layout(doc: GraphDoc): Promise<LaidOut> {
  return layoutElkGraph(toElk(doc));
}
