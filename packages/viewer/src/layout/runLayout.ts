// layout/runLayout.ts — the one shared layout code path (spec §5, M2).
//
// layout(doc) composes sizeNode/toElk (document -> measured ELK input),
// the real ELK layered layout, and flatten (relative ELK output ->
// absolute coordinates). Tests run it headless in Node; the worker
// (worker.ts) calls the exact same function in the browser, so there
// is exactly one code path to trust.
//
// The default engine is elkjs's BUNDLED build ('elkjs/lib/elk.bundled.js'),
// which runs the layout in-process. CAUTION: that build cannot execute
// inside a web worker — its environment detection (document undefined,
// self defined) makes it register ITSELF as an elk worker and export
// nothing, so `new ELK()` throws there. It is constructed lazily so
// merely importing this module is safe anywhere; browser callers inject
// an engine backed by elkjs's own worker instead (see elkBrowser.ts).
//
// Pure async function, no DOM. The result is viewer-side geometry only
// and is NEVER written back to the document (spec §1.4/§3.1).

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs';
import type { GraphDoc } from '@diagram-engine/core';
import { flowReversedEdgeIds } from './flow.js';
import { toElk } from './toElk.js';
import { flatten, type LaidOut } from './fromElk.js';

/** The one capability the pipeline needs from an ELK engine. */
export interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

let defaultElk: ElkEngine | null = null;
function bundledElk(): ElkEngine {
  return (defaultElk ??= new ELK());
}

/**
 * Lay out an ALREADY-SIZED ELK graph: ELK layered layout -> flattened
 * absolute geometry. The sized graph is built by toElk on the MAIN
 * thread (spec §5.4), so §5.1's cached offscreen-canvas text
 * measurement actually runs where a canvas exists.
 */
export async function layoutElkGraph(
  graph: ElkNode,
  elk: ElkEngine = bundledElk(),
  flowReversed?: ReadonlySet<string>
): Promise<LaidOut> {
  const laidOut = await elk.layout(graph);
  return flatten(laidOut, flowReversed);
}

/**
 * Lay out a document: GraphDoc -> sized ELK graph -> ELK layered
 * layout -> flattened absolute geometry. Runs in-process on the
 * default engine (tests, Node); browser callers pass the
 * worker-backed engine from elkBrowser.ts.
 */
export async function layout(
  doc: GraphDoc,
  elk?: ElkEngine
): Promise<LaidOut> {
  // §5.5's reversed set is derived from the DOCUMENT, so it is computed here
  // rather than recovered from the ELK graph — toElk has already swapped
  // those endpoints and the swap is not recoverable from its output.
  return layoutElkGraph(toElk(doc), elk, flowReversedEdgeIds(doc));
}
