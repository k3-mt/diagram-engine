// M4 Step 13 tests: fit-to-content viewport math (spec §8.3), scroll-zoom
// invariants, the status-bar formatters (§8.4) and the reconnecting
// WebSocket client state machine (§2.4, §8.4) driven by a fake socket.
//
// Everything here is pure or fake-timer driven — no DOM, no React render.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIT_PAD,
  MAX_FIT_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  PAN_THRESHOLD_PX,
  advanceDrag,
  beginDrag,
  clampScale,
  dragDistance,
  dragPan,
  endDrag,
  endPress,
  fitToContent,
  panBy,
  panCursor,
  takesCapture,
  viewportTransform,
  wheelZoomFactor,
  zoomAt,
  type Bounds,
  type DragState,
  type Viewport,
} from '../src/render/viewport';
import {
  CONNECTION_COLOR,
  ERROR_COLOR,
  countsText,
  docErrorText,
  lastUpdateText,
} from '../src/render/StatusBar';
import {
  connectViewer,
  defaultEventsUrl,
  parseDocMessage,
  parseServerMessage,
  type ConnectionState,
  type EventSourceLike,
  type SseMessageEvent,
} from '../src/live';
import type { GraphDoc } from '@diagram-engine/core';

/** World point -> screen point under a camera. */
function toScreen(vp: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: x * vp.scale + vp.tx, y: y * vp.scale + vp.ty };
}
/** Screen point -> world point under a camera. */
function toWorld(vp: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - vp.tx) / vp.scale, y: (y - vp.ty) / vp.scale };
}

describe('fitToContent — spec §8.3 formula', () => {
  it('matches the spec expression exactly for wide content', () => {
    const b: Bounds = { x: 0, y: 0, width: 2000, height: 400 };
    const vw = 1200;
    const vh = 800;
    const vp = fitToContent(b, vw, vh);

    const expectedScale = Math.min(
      (vw - 2 * FIT_PAD) / b.width,
      (vh - 2 * FIT_PAD) / b.height,
      1.2,
    );
    expect(vp.scale).toBe(expectedScale);
    // Wide content is width-limited.
    expect(vp.scale).toBeCloseTo((vw - 2 * FIT_PAD) / b.width, 12);
    expect(vp.tx).toBe((vw - b.width * expectedScale) / 2 - b.x * expectedScale);
    expect(vp.ty).toBe((vh - b.height * expectedScale) / 2 - b.y * expectedScale);
  });

  it('is height-limited for tall content and honours a non-zero origin', () => {
    const b: Bounds = { x: -300, y: 120, width: 400, height: 2400 };
    const vw = 1000;
    const vh = 700;
    const vp = fitToContent(b, vw, vh);

    expect(vp.scale).toBeCloseTo((vh - 2 * FIT_PAD) / b.height, 12);
    expect(vp.tx).toBe((vw - b.width * vp.scale) / 2 - b.x * vp.scale);
    expect(vp.ty).toBe((vh - b.height * vp.scale) / 2 - b.y * vp.scale);
  });

  it('caps small content at 1.2 — never upscales further', () => {
    const b: Bounds = { x: 10, y: 10, width: 50, height: 40 };
    const vp = fitToContent(b, 1600, 1000);
    expect(vp.scale).toBe(MAX_FIT_SCALE);
    expect(vp.scale).toBe(1.2);
  });

  it('centres the content in the viewport', () => {
    const b: Bounds = { x: 40, y: -60, width: 800, height: 600 };
    const vw = 1280;
    const vh = 720;
    const vp = fitToContent(b, vw, vh);
    const tl = toScreen(vp, b.x, b.y);
    const br = toScreen(vp, b.x + b.width, b.y + b.height);
    // Equal slack on left/right and top/bottom.
    expect(tl.x).toBeCloseTo(vw - br.x, 9);
    expect(tl.y).toBeCloseTo(vh - br.y, 9);
    // And it fits inside the padded box.
    expect(tl.x).toBeGreaterThanOrEqual(FIT_PAD - 1e-9);
    expect(br.x).toBeLessThanOrEqual(vw - FIT_PAD + 1e-9);
  });

  it('falls back to MIN_SCALE for degenerate viewports', () => {
    const b: Bounds = { x: 0, y: 0, width: 100, height: 100 };
    expect(fitToContent(b, 2 * FIT_PAD, 400).scale).toBe(MIN_SCALE);
    expect(fitToContent(b, 10, 10).scale).toBe(MIN_SCALE);
  });

  it('caps zero-size bounds at 1.2 rather than producing Infinity', () => {
    const vp = fitToContent({ x: 5, y: 5, width: 0, height: 0 }, 800, 600);
    expect(vp.scale).toBe(MAX_FIT_SCALE);
    expect(Number.isFinite(vp.tx)).toBe(true);
    expect(Number.isFinite(vp.ty)).toBe(true);
  });
});

describe('scroll zoom', () => {
  const vp: Viewport = { scale: 0.8, tx: 130, ty: -45 };

  it('keeps the world point under the cursor fixed', () => {
    const cx = 512;
    const cy = 300;
    const before = toWorld(vp, cx, cy);
    for (const factor of [1.25, 0.8, 2, 0.5]) {
      const next = zoomAt(vp, cx, cy, factor);
      const after = toWorld(next, cx, cy);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it('keeps the cursor fixed even when the scale clamps', () => {
    const cx = 200;
    const cy = 90;
    const before = toWorld(vp, cx, cy);
    const zoomedOut = zoomAt(vp, cx, cy, 0.0001);
    expect(zoomedOut.scale).toBe(MIN_SCALE);
    const zoomedIn = zoomAt(vp, cx, cy, 10000);
    expect(zoomedIn.scale).toBe(MAX_SCALE);
    for (const next of [zoomedOut, zoomedIn]) {
      const after = toWorld(next, cx, cy);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it('clamps into ~0.2–3', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
    expect(MIN_SCALE).toBe(0.2);
    expect(MAX_SCALE).toBe(3);
  });

  it('scrolling up zooms in and down zooms out', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });
});

describe('pan and transform', () => {
  it('pans by a screen delta without touching scale', () => {
    const vp: Viewport = { scale: 0.6, tx: 10, ty: 20 };
    const next = panBy(vp, -30, 45);
    expect(next).toEqual({ scale: 0.6, tx: -20, ty: 65 });
  });

  it('renders a css transform', () => {
    expect(viewportTransform({ scale: 2, tx: 3, ty: 4 })).toBe(
      'translate(3px, 4px) scale(2)',
    );
  });
});

// ---------------------------------------------------------------------------
// Capability C: drag panning (plain left-drag and space-drag share the machine).

/** Replay a whole gesture through the pure machine: down, moves…, up. */
function gesture(
  vp: Viewport,
  from: [number, number],
  moves: Array<[number, number]>,
  mode: 'mouse' | 'space' = 'mouse',
): { vp: Viewport; drag: DragState | null; moved: boolean } {
  let drag: DragState | null = beginDrag(from[0], from[1], mode);
  let cur = vp;
  for (const [x, y] of moves) {
    const step = dragPan(cur, drag as DragState, x, y);
    cur = step.vp;
    drag = step.drag;
  }
  const { drag: after, moved } = endDrag(drag);
  return { vp: cur, drag: after, moved };
}

describe('drag panning — capability C', () => {
  const vp: Viewport = { scale: 0.75, tx: 40, ty: -12 };

  it('translates the camera by exactly (B - A) in screen px, one move', () => {
    const A: [number, number] = [100, 200];
    const B: [number, number] = [340, 130];
    const out = gesture(vp, A, [B]);
    expect(out.vp.tx).toBeCloseTo(vp.tx + (B[0] - A[0]), 9);
    expect(out.vp.ty).toBeCloseTo(vp.ty + (B[1] - A[1]), 9);
    expect(out.vp.scale).toBe(vp.scale);
    expect(out.moved).toBe(true);
  });

  it('moves the content by (B - A)/scale in world units — the hand 1:1', () => {
    const A: [number, number] = [10, 10];
    const B: [number, number] = [90, -30];
    const out = gesture(vp, A, [B]);
    // The world point under the pointer at A is under the pointer at B.
    const worldAtA = toWorld(vp, A[0], A[1]);
    const worldAtB = toWorld(out.vp, B[0], B[1]);
    expect(worldAtB.x).toBeCloseTo(worldAtA.x, 9);
    expect(worldAtB.y).toBeCloseTo(worldAtA.y, 9);
    // Equivalently: a fixed world point shifted by (B-A)/scale on screen,
    // i.e. the world offset the camera travelled is (B-A)/scale.
    const dWorldX = (out.vp.tx - vp.tx) / vp.scale;
    const dWorldY = (out.vp.ty - vp.ty) / vp.scale;
    expect(dWorldX).toBeCloseTo((B[0] - A[0]) / vp.scale, 9);
    expect(dWorldY).toBeCloseTo((B[1] - A[1]) / vp.scale, 9);
  });

  it('accumulates many small moves to exactly (B - A), no swallowed pixels', () => {
    const A: [number, number] = [0, 0];
    const moves: Array<[number, number]> = [];
    for (let i = 1; i <= 20; i += 1) moves.push([i * 7, -i * 3]);
    const B = moves[moves.length - 1] as [number, number];
    const out = gesture(vp, A, moves);
    expect(out.vp.tx).toBeCloseTo(vp.tx + (B[0] - A[0]), 9);
    expect(out.vp.ty).toBeCloseTo(vp.ty + (B[1] - A[1]), 9);
  });

  it('suppresses jitter below the threshold — a click is not swallowed', () => {
    const A: [number, number] = [500, 400];
    const jitter = gesture(vp, A, [
      [501, 400],
      [500, 401],
      [502, 401],
      [500, 400],
    ]);
    expect(jitter.vp).toEqual(vp); // camera untouched
    expect(jitter.moved).toBe(false); // reported as a click, not a pan
    expect(PAN_THRESHOLD_PX).toBeGreaterThan(0);
    expect(dragDistance(beginDrag(...A), 502, 401)).toBeLessThanOrEqual(
      PAN_THRESHOLD_PX,
    );
  });

  it('once past the threshold, applies the FULL travel from the origin', () => {
    // First real move is 10px right: the camera moves 10, not 10 minus the
    // threshold — dragging A→B always lands on (B - A).
    const d0 = beginDrag(0, 0);
    const below = advanceDrag(d0, 2, 0);
    expect(below.dx).toBe(0);
    expect(below.drag.active).toBe(false);
    const above = advanceDrag(below.drag, 10, 0);
    expect(above.dx).toBe(10);
    expect(above.dy).toBe(0);
    expect(above.drag.active).toBe(true);
  });

  it('walks down → move → up and returns to idle', () => {
    let drag: DragState | null = beginDrag(20, 20, 'mouse', 7);
    expect(drag.active).toBe(false);
    expect(drag.mode).toBe('mouse');
    expect(drag.pointerId).toBe(7);

    const step = advanceDrag(drag, 120, 60);
    drag = step.drag;
    expect(drag.active).toBe(true);
    expect(drag.lastX).toBe(120);
    expect(drag.lastY).toBe(60);

    const up = endDrag(drag);
    expect(up.drag).toBeNull();
    expect(up.moved).toBe(true);
    // Idle: a further "up" is harmless and reports no movement.
    expect(endDrag(null)).toEqual({ drag: null, moved: false });
  });

  it('a pan that ends over a node is not a click (§18.7 target selection)', () => {
    // The blast overlay's click-to-target hangs off the node groups, and a
    // drag that starts and ends over the same box still fires a `click`. The
    // guard is `moved` — carried by the hook as didPan() — and NOT a second
    // threshold invented at the call site. Both ends of the line, asserted
    // here so a future change to PAN_THRESHOLD_PX moves selection with it.
    const A: [number, number] = [200, 200];
    const panned = gesture(vp, A, [[400, 260]]);
    expect(panned.moved).toBe(true); // didPan() -> the click is dropped

    const tapped = gesture(vp, A, [[201, 200]]);
    expect(tapped.moved).toBe(false); // didPan() -> the click targets
    expect(tapped.vp).toEqual(vp); // and the camera never moved either
  });

  it('a second end event does not rewrite a pan into a click', () => {
    // onPointerLeave IS onPointerUp, and endDrag(null) reports moved:false —
    // so folding a second call in naively turns "that was a pan" into "that
    // was a click". On touch the pointer ceases to exist at pointerup, so the
    // UA fires pointerleave straight after it and BEFORE the compatibility
    // click: the pan that ended over a box would have targeted it.
    const drag = gesture(vp, [200, 200], [[400, 260]]).drag;
    expect(drag).toBe(null); // the gesture already ended
    const first = endPress(beginDrag(200, 200, 'mouse', 1), false);
    expect(first.panned).toBe(false); // never moved: a click
    const panned = endPress(
      advanceDrag(beginDrag(200, 200, 'mouse', 1), 400, 260).drag,
      false,
    );
    expect(panned.panned).toBe(true);
    // the second call has no press in flight and must leave the answer alone
    expect(endPress(null, true)).toEqual({ drag: null, panned: true });
    expect(endPress(null, false)).toEqual({ drag: null, panned: false });
  });

  it('takes pointer capture only once the press has become a pan', () => {
    // Capturing on EVERY pointerdown retargets the press's compatibility mouse
    // events to the container, and Chrome derives a click's target from those
    // — so the node group's onClick never fires and §18.7's click-to-target is
    // dead in the browser, invisibly to jsdom. Capture is only needed once
    // panning has started, which is also exactly when the click no longer is.
    const press = beginDrag(200, 200, 'mouse', 1);
    expect(takesCapture(false, press)).toBe(false); // a candidate click
    const under = advanceDrag(press, 202, 200).drag; // still under threshold
    expect(under.active).toBe(false);
    expect(takesCapture(false, under)).toBe(false);
    const panning = advanceDrag(press, 400, 260).drag;
    expect(panning.active).toBe(true);
    expect(takesCapture(false, panning)).toBe(true);
    expect(takesCapture(true, panning)).toBe(false); // taken once, not per move
  });

  it('space-drag behaves identically and keeps its mode label', () => {
    const A: [number, number] = [300, 300];
    const B: [number, number] = [250, 380];
    const mouse = gesture(vp, A, [B], 'mouse');
    const space = gesture(vp, A, [B], 'space');
    expect(space.vp).toEqual(mouse.vp);
    expect(space.moved).toBe(true);
    expect(beginDrag(A[0], A[1], 'space').mode).toBe('space');
    // Space-drag jitter is suppressed the same way.
    expect(gesture(vp, A, [[301, 301]], 'space').vp).toEqual(vp);
  });

  it('never touches scale — panning is translation only', () => {
    for (const scale of [MIN_SCALE, 0.5, 1, MAX_SCALE]) {
      const out = gesture({ scale, tx: 0, ty: 0 }, [0, 0], [[77, -55]]);
      expect(out.vp.scale).toBe(scale);
    }
  });

  it('reports grab at rest and grabbing while held', () => {
    expect(panCursor(false)).toBe('grab');
    expect(panCursor(true)).toBe('grabbing');
  });
});

describe('status bar formatting — spec §8.4', () => {
  it('formats counts with the middle dot and correct plurals', () => {
    expect(countsText({ nodes: 11, groups: 2, edges: 9 })).toBe(
      '11 nodes · 2 groups · 9 edges',
    );
    expect(countsText({ nodes: 1, groups: 1, edges: 1 })).toBe(
      '1 node · 1 group · 1 edge',
    );
    expect(countsText({ nodes: 0, groups: 0, edges: 0 })).toBe(
      '0 nodes · 0 groups · 0 edges',
    );
  });

  it('formats the elapsed label', () => {
    expect(lastUpdateText(0)).toBe('last update just now');
    expect(lastUpdateText(2400)).toBe('last update 2s ago');
    expect(lastUpdateText(65_000)).toBe('last update 1m ago');
    expect(lastUpdateText(3 * 3_600_000)).toBe('last update 3h ago');
  });

  it('has a distinct dot colour per state', () => {
    const colours = new Set(Object.values(CONNECTION_COLOR));
    expect(colours.size).toBe(3);
    expect(CONNECTION_COLOR.connected).not.toBe(CONNECTION_COLOR.reconnecting);
    expect(CONNECTION_COLOR.down).not.toBe(CONNECTION_COLOR.reconnecting);
  });

  it('summarises a rejected graph.json in one amber line (§9)', () => {
    expect(docErrorText(['nodes: expected array'])).toBe(
      'graph.json rejected — nodes: expected array',
    );
    // Extra messages are counted, not dumped into the strip.
    expect(docErrorText(['a', 'b', 'c'])).toBe('graph.json rejected — a (+2 more)');
    // Multi-line and over-long messages are cut to one short line.
    expect(docErrorText(['first line\nsecond line'])).toBe(
      'graph.json rejected — first line',
    );
    const long = docErrorText(['x'.repeat(200)]);
    expect(long.length).toBeLessThan(90);
    expect(long.endsWith('…')).toBe(true);
    // Never an empty message, even from an empty list.
    expect(docErrorText([])).toBe('graph.json rejected — invalid graph.json');
    // readDoc's absolute-path prefix is dropped — it would eat the strip.
    expect(
      docErrorText(['/very/long/project/path/.diagram/graph.json: not valid JSON: oops']),
    ).toBe('graph.json rejected — not valid JSON: oops');
    // A schema error has no path prefix and is left alone.
    expect(docErrorText(['nodes.0.type: invalid enum value'])).toBe(
      'graph.json rejected — nodes.0.type: invalid enum value',
    );
  });

  it('uses amber for the rejection, matching the reconnect dot (§8.4, §9)', () => {
    expect(ERROR_COLOR).toBe(CONNECTION_COLOR.reconnecting);
  });
});

// ---------------------------------------------------------------------------
// Fake EventSource: records every instance so the test can open/drop them.
//
// Note what is NOT here any more: this fake has no way to trigger a redial,
// because the client no longer has one. EventSource reconnects natively
// (§16.3), so the browser owns the retry schedule and the tests that pinned
// the hand-rolled 500ms doubling backoff went with the code they covered.

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: SseMessageEvent) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  drop(): void {
    this.onerror?.();
  }
  send(data: unknown): void {
    this.onmessage?.({ data });
  }
  static last(): FakeEventSource {
    const s = FakeEventSource.instances.at(-1);
    if (s === undefined) throw new Error('no stream opened');
    return s;
  }
}

const ES = FakeEventSource as unknown as new (url: string) => EventSourceLike;

const doc: GraphDoc = {
  version: 1,
  title: 'Checkout platform',
  direction: 'DOWN',
  nodes: [],
  groups: [],
  edges: [],
} as unknown as GraphDoc;

describe('live client — spec §2.4, §8.4', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks connect → drop → reconnecting → down → reconnected', () => {
    const states: ConnectionState[] = [];
    const client = connectViewer({
      url: 'http://test/events',
      onDoc: () => {},
      onState: (s) => states.push(s),
      eventSource: ES,
    });

    expect(states).toEqual(['reconnecting']);
    FakeEventSource.last().open();
    expect(states).toEqual(['reconnecting', 'connected']);
    expect(client.state).toBe('connected');

    // The stream drops: amber immediately, red only after 5s.
    FakeEventSource.last().drop();
    expect(client.state).toBe('reconnecting');
    vi.advanceTimersByTime(4_999);
    expect(client.state).toBe('reconnecting');
    vi.advanceTimersByTime(2);
    expect(client.state).toBe('down');
    expect(states).toEqual(['reconnecting', 'connected', 'reconnecting', 'down']);

    // EventSource reconnects itself and fires onopen on the SAME object:
    // green again, with no new instance constructed by us.
    FakeEventSource.last().open();
    expect(client.state).toBe('connected');
    expect(states.at(-1)).toBe('connected');
    client.close();
  });

  it('never redials — the browser owns the retry schedule (§16.3)', () => {
    connectViewer({
      url: 'http://test/events',
      onDoc: () => {},
      eventSource: ES,
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    // Repeated failures over a long window: still exactly one EventSource.
    for (let i = 0; i < 6; i++) {
      FakeEventSource.last().drop();
      vi.advanceTimersByTime(5_000);
    }
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('stays red until the stream is actually back', () => {
    const states: ConnectionState[] = [];
    const client = connectViewer({
      url: 'http://test/events',
      onDoc: () => {},
      onState: (s) => states.push(s),
      eventSource: ES,
    });
    FakeEventSource.last().open();
    FakeEventSource.last().drop();
    vi.advanceTimersByTime(5_001);
    expect(client.state).toBe('down');
    // Further failed attempts while down must not flap the dot back to amber.
    FakeEventSource.last().drop();
    FakeEventSource.last().drop();
    expect(client.state).toBe('down');
    expect(states).toEqual(['reconnecting', 'connected', 'reconnecting', 'down']);
  });

  it('delivers docs from {type:"doc"} frames and ignores everything else', () => {
    const seen: GraphDoc[] = [];
    connectViewer({
      url: 'http://test/events',
      onDoc: (d) => seen.push(d),
      eventSource: ES,
    });
    const s = FakeEventSource.last();
    s.open();
    s.send(JSON.stringify({ type: 'doc', doc }));
    s.send(JSON.stringify({ type: 'hello' }));
    s.send('not json at all');
    s.send(JSON.stringify({ type: 'doc' }));
    s.send(12345);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.title).toBe('Checkout platform');
  });

  it('routes {type:"error"} frames to onError and never to onDoc (§9)', () => {
    const docs: GraphDoc[] = [];
    const errs: string[][] = [];
    connectViewer({
      url: 'http://test/events',
      onDoc: (d) => docs.push(d),
      onError: (e) => errs.push(e),
      eventSource: ES,
    });
    const s = FakeEventSource.last();
    s.open();
    s.send(JSON.stringify({ type: 'error', errors: ['nodes: expected array'] }));
    // A rejected doc must not repaint: nothing reaches onDoc.
    expect(docs).toEqual([]);
    expect(errs).toEqual([['nodes: expected array']]);

    // A good doc still flows afterwards (recovery).
    s.send(JSON.stringify({ type: 'doc', doc }));
    expect(docs).toHaveLength(1);
  });

  it('survives an error frame when no onError handler is supplied', () => {
    connectViewer({
      url: 'http://test/events',
      onDoc: () => {},
      eventSource: ES,
    });
    const s = FakeEventSource.last();
    s.open();
    expect(() => s.send(JSON.stringify({ type: 'error', errors: ['x'] }))).not.toThrow();
  });

  it('closes the stream and goes silent on close()', () => {
    const states: ConnectionState[] = [];
    const client = connectViewer({
      url: 'http://test/events',
      onDoc: () => {},
      onState: (s) => states.push(s),
      eventSource: ES,
    });
    FakeEventSource.last().open();
    client.close();
    expect(FakeEventSource.last().closed).toBe(true);
    // No further state changes, and the 'down' fuse must not burn after close.
    FakeEventSource.last().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(states).toEqual(['reconnecting', 'connected']);
  });
});

describe('parseDocMessage / defaultEventsUrl', () => {
  it('returns null for non-string and malformed payloads', () => {
    expect(parseDocMessage(null)).toBeNull();
    expect(parseDocMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseDocMessage('{')).toBeNull();
    expect(parseDocMessage('[]')).toBeNull();
    expect(parseDocMessage(JSON.stringify({ type: 'doc', doc: 'nope' }))).toBeNull();
  });

  it('returns the doc for a well-formed frame', () => {
    expect(parseDocMessage(JSON.stringify({ type: 'doc', doc }))).toMatchObject({
      title: 'Checkout platform',
    });
  });

  it('decodes error frames, and rejects malformed ones', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'error', errors: ['a', 'b'] }))).toEqual({
      type: 'error',
      errors: ['a', 'b'],
    });
    // Non-string entries are dropped, not trusted into the UI.
    expect(parseServerMessage(JSON.stringify({ type: 'error', errors: ['a', 7] }))).toEqual({
      type: 'error',
      errors: ['a'],
    });
    expect(parseServerMessage(JSON.stringify({ type: 'error' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'error', errors: 'nope' }))).toBeNull();
    // An error frame is never mistaken for a doc.
    expect(parseDocMessage(JSON.stringify({ type: 'error', errors: ['a'] }))).toBeNull();
  });

  it('falls back to a localhost http url on the events path outside a browser', () => {
    expect(defaultEventsUrl()).toMatch(/^http:\/\/.+\/__diagram\/events$/);
  });
});
