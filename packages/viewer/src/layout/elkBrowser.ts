// layout/elkBrowser.ts — the browser-side ELK engine (spec §2.1: layout
// runs off the UI thread).
//
// Why this exists: elk.bundled.js cannot run inside a web worker we own —
// in worker scope its environment detection registers itself as an elk
// worker and exports no constructor (see runLayout.ts). So in the
// browser, the threading is provided by elkjs's OWN worker instead:
// elk-api.js on the main thread posting to elk-worker.min.js, the script
// elkjs ships precisely for this. Our §5.4 request/stale-discard protocol
// is unchanged; only the heavy ELK computation crosses a thread boundary.
//
// BROWSER-ONLY MODULE: the `?worker` import is vite syntax and does not
// resolve under plain Node, so nothing that runs in vitest may import
// this file. Node code paths use runLayout's bundled default engine.

import ELKApi from 'elkjs/lib/elk-api.js';
import ElkWorkerCtor from 'elkjs/lib/elk-worker.min.js?worker';
import type { ElkEngine } from './runLayout.js';

let browserElk: ElkEngine | null = null;

/** ELK engine backed by elkjs's own web worker. One instance, reused. */
export function elkWithOwnWorker(): ElkEngine {
  return (browserElk ??= new ELKApi({
    workerFactory: () => new ElkWorkerCtor(),
  }));
}
