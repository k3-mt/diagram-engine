// main.tsx — the PRODUCT viewer app (spec §8, §9; M4+M5 integration).
//
// Data flow, once per document:
//
//   diagram serve ──ws {type:'doc'}──▶ connectViewer (ws.ts)
//        └▶ LayoutClient.request(doc)            §5.4 protocol, stale-discard
//             └▶ handleLayoutRequest + elkWithOwnWorker()   ELK off the UI thread
//                  └▶ LaidOut ──composeFramePaths (ONCE per frame)──▶ paths[]
//                       └▶ <Canvas> inside the useViewport transform + <StatusBar>
//
// Threading note (do not "fix" this): elk.bundled.js cannot run inside a
// worker we own — in worker scope it registers itself as an elk worker and
// exports no constructor. So the §5.4 protocol runs INLINE on the main
// thread while the heavy ELK compute runs on elkjs's own worker via
// elkBrowser.elkWithOwnWorker(). Same pattern as debug/DebugCanvas.tsx.
//
// ?debug in the query string mounts the DEBUG fixture renderer instead —
// that page is the fixture test surface and must keep working.
//
// Geometry is derived per frame and NEVER persisted to the document (§1.4).

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { GNode, GraphDoc } from '@diagram-engine/core';
import { DebugCanvas } from './debug/DebugCanvas.js';
import { composeFramePaths } from './geometry';
import { elkWithOwnWorker } from './layout/elkBrowser.js';
import type { LaidOut, Rect } from './layout/fromElk.js';
import {
  LayoutClient,
  handleLayoutRequest,
  type LayoutRequest,
  type WorkerLike,
} from './layout/worker.js';
import { Canvas } from './render/Canvas.js';
import { HoverCard } from './render/HoverCard.js';
import { BAR_HEIGHT, StatusBar, type DocError } from './render/StatusBar.js';
import { theme } from './render/theme.js';
import { useViewport } from './render/viewport.js';
import { connectViewer, type ConnectionState } from './ws.js';

/** WorkerLike speaking the §5.4 protocol on this thread (see header note). */
function makeLayoutWorker(): WorkerLike {
  const elk = typeof Worker !== 'undefined' ? elkWithOwnWorker() : undefined;
  const listeners: ((ev: { data: unknown }) => void)[] = [];
  return {
    postMessage(msg) {
      void handleLayoutRequest(msg as LayoutRequest, elk).then((res) => {
        for (const l of listeners) l({ data: res });
      });
    },
    addEventListener(_type, cb) {
      listeners.push(cb);
    },
  };
}

/** Everything one painted frame needs. Rebuilt only when a layout arrives. */
interface Frame {
  doc: GraphDoc;
  laidOut: LaidOut;
  /** Composed edge paths, index-aligned with laidOut.edges. */
  paths: string[];
}

/**
 * One crossing pass for the whole frame (§6.2/§6.8): hops are detected
 * against the segments of ALL edges at once and guarded against NODE rects
 * only — groups are containers, not obstacles.
 */
function buildFrame(doc: GraphDoc, laidOut: LaidOut): Frame {
  const nodeRects: Rect[] = doc.nodes.flatMap((n) => {
    const r = laidOut.nodes.get(n.id);
    return r ? [r] : [];
  });
  return { doc, laidOut, paths: composeFramePaths(laidOut.edges, nodeRects) };
}

/** Window size minus the status strip, tracked for fit-to-content (§8.3). */
function useCanvasSize(): { vw: number; vh: number } {
  const read = (): { vw: number; vh: number } =>
    typeof window === 'undefined'
      ? { vw: 0, vh: 0 }
      : { vw: window.innerWidth, vh: Math.max(0, window.innerHeight - BAR_HEIGHT) };
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = (): void => setSize(read());
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

const hintStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  textAlign: 'center',
  pointerEvents: 'none',
  color: theme.text.secondary,
  font: '14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
};

/** What the hover panel needs: which node, and where the cursor is. */
interface HoverState {
  /** id of the node under the pointer, or null for "nothing hovered". */
  id: string | null;
  /** Cursor position in CONTAINER coordinates (HoverCard's contract). */
  x: number;
  y: number;
}

/**
 * Hover tracking for the inspection panel (capability B). INSPECTION ONLY —
 * nothing here patches or mutates the document (§1.6); it is the same class
 * of control as the viewport (§7).
 *
 * Three details this hook exists to get right:
 *
 *  1. NEVER FIGHT THE PAN. While `panning` is true the hover is cleared and
 *     new enters are ignored, so dragging the canvas past a node does not
 *     pop a card under the moving hand. The hover returns on the next real
 *     mouse enter after the button comes up.
 *  2. DEBOUNCE THE LEAVE. Canvas attaches the handlers to the node-box and
 *     node-content groups separately, so sliding the pointer from a box onto
 *     its own text emits leave(null) immediately followed by enter(id). The
 *     null is deferred by one animation frame and cancelled if an enter
 *     arrives, which turns that into no visible change at all.
 *  3. COALESCE THE MOVES. Cursor positions land in a ref and are published
 *     to React at most once per frame, so a 40-row entity table is not
 *     re-rendered per mousemove.
 */
function useHover(panning: boolean): {
  hover: HoverState;
  onHoverNode: (id: string | null) => void;
  onHoverMove: (e: ReactMouseEvent<Element>) => void;
  containerRef: (el: HTMLDivElement | null) => void;
} {
  const [hover, setHover] = useState<HoverState>({ id: null, x: 0, y: 0 });
  const elRef = useRef<HTMLDivElement | null>(null);
  const ptRef = useRef({ x: 0, y: 0 });
  const moveRaf = useRef<number | null>(null);
  const leaveRaf = useRef<number | null>(null);
  const panningRef = useRef(panning);
  panningRef.current = panning;

  const cancelLeave = useCallback(() => {
    if (leaveRaf.current === null) return;
    cancelAnimationFrame(leaveRaf.current);
    leaveRaf.current = null;
  }, []);

  // A drag owns the pointer: drop the card the moment a pan starts.
  useEffect(() => {
    if (!panning) return;
    cancelLeave();
    setHover((h) => (h.id === null ? h : { ...h, id: null }));
  }, [panning, cancelLeave]);

  useEffect(
    () => () => {
      if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
      if (leaveRaf.current !== null) cancelAnimationFrame(leaveRaf.current);
    },
    [],
  );

  const onHoverNode = useCallback(
    (id: string | null) => {
      if (id === null) {
        cancelLeave();
        leaveRaf.current = requestAnimationFrame(() => {
          leaveRaf.current = null;
          setHover((h) => (h.id === null ? h : { ...h, id: null }));
        });
        return;
      }
      if (panningRef.current) return; // rule 1: the drag wins
      cancelLeave();
      setHover((h) => (h.id === id ? h : { ...h, id }));
    },
    [cancelLeave],
  );

  const onHoverMove = useCallback((e: ReactMouseEvent<Element>) => {
    const el = elRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    ptRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (moveRaf.current !== null) return; // one publish per frame
    moveRaf.current = requestAnimationFrame(() => {
      moveRaf.current = null;
      const { x, y } = ptRef.current;
      setHover((h) => (h.x === x && h.y === y ? h : { ...h, x, y }));
    });
  }, []);

  const containerRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
  }, []);

  return { hover, onHoverNode, onHoverMove, containerRef };
}

/** Friendly empty state — never a blank page (§1.2). */
function EmptyHint({ connected }: { connected: boolean }): JSX.Element {
  return (
    <div style={hintStyle} data-testid="empty-hint">
      <div style={{ color: theme.text.primary, fontSize: 16, fontWeight: 600 }}>
        Nothing to draw yet
      </div>
      <div>
        {connected
          ? 'Ask your agent to describe an architecture — the diagram appears here as it patches .diagram/graph.json.'
          : 'Waiting for `diagram serve` — start it in your project and this page will connect on its own.'}
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  const [doc, setDoc] = useState<GraphDoc | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('reconnecting');
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  // A rejected graph.json (§9). Never touches `frame` — the last good
  // diagram stays on screen; only the status bar goes amber.
  const [docError, setDocError] = useState<DocError | null>(null);

  const clientRef = useRef<LayoutClient | null>(null);
  // The doc belonging to the LATEST request; LayoutClient only ever delivers
  // the latest response, so pairing through this ref is safe (§5.4).
  const pendingDocRef = useRef<GraphDoc | null>(null);

  // Layout client + socket: one of each for the life of the page.
  useEffect(() => {
    const client = new LayoutClient(
      makeLayoutWorker(),
      (laidOut) => {
        const d = pendingDocRef.current;
        if (d) setFrame(buildFrame(d, laidOut));
      },
      (err) => console.error('[viewer] layout failed:', err),
    );
    clientRef.current = client;

    const socket = connectViewer({
      onDoc: (next) => {
        setDoc(next);
        setLastUpdate(Date.now());
        setDocError(null); // a good doc clears the amber

        if (next.nodes.length === 0 && next.groups.length === 0) {
          // Nothing to lay out; drop the stale frame so the hint shows.
          pendingDocRef.current = null;
          setFrame(null);
          return;
        }
        pendingDocRef.current = next;
        client.request(next);
      },
      // NOTE: no setFrame / setDoc here — §9 forbids repainting or blanking
      // the canvas on a rejected document.
      onError: (errors) => setDocError({ errors, at: Date.now() }),
      onState: setConnection,
    });

    return () => {
      socket.close();
      clientRef.current = null;
    };
  }, []);

  const { vw, vh } = useCanvasSize();
  const bounds = useMemo(
    () =>
      frame === null
        ? null
        : { x: 0, y: 0, width: frame.laidOut.width, height: frame.laidOut.height },
    [frame],
  );
  const view = useViewport(bounds, vw, vh);

  const counts = {
    nodes: doc?.nodes.length ?? 0,
    groups: doc?.groups.length ?? 0,
    edges: doc?.edges.length ?? 0,
  };

  // Capability B. The hovered id is resolved against the CURRENT frame, so a
  // document update that removes the node simply closes the card.
  const hoverApi = useHover(view.panning);
  const { hover } = hoverApi;
  const hoveredNode: GNode | null =
    frame === null || hover.id === null
      ? null
      : (frame.doc.nodes.find((n) => n.id === hover.id) ?? null);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: theme.canvas,
      }}
    >
      <div
        ref={(el: HTMLDivElement | null) => {
          // Two consumers of the same element: useViewport attaches the
          // non-passive wheel listener, useHover needs the rect to convert
          // client coordinates into container coordinates.
          view.containerRef(el);
          hoverApi.containerRef(el);
        }}
        onPointerDown={view.onPointerDown}
        onPointerMove={view.onPointerMove}
        onPointerUp={view.onPointerUp}
        onPointerLeave={view.onPointerLeave}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: BAR_HEIGHT,
          overflow: 'hidden',
          // 'grab' at rest / 'grabbing' while held — plain left-drag pans
          // the canvas (capability C), space-drag still does too.
          cursor: view.cursor,
          touchAction: 'none',
        }}
      >
        {frame === null ? (
          <EmptyHint connected={connection === 'connected'} />
        ) : (
          <svg
            width="100%"
            height="100%"
            style={{ display: 'block' }}
            role="img"
            aria-label={doc?.title ?? 'diagram'}
          >
            {/* The camera lives on this <g>: useViewport hands back a CSS
                transform (px units + a 250ms transition), which belongs in
                `style`, not in the SVG transform attribute. */}
            <g style={view.style}>
              <Canvas
                doc={frame.doc}
                laidOut={frame.laidOut}
                paths={frame.paths}
                hoveredId={hoveredNode?.id ?? null}
                onHoverNode={hoverApi.onHoverNode}
                onHoverMove={hoverApi.onHoverMove}
              />
            </g>
          </svg>
        )}
        {/* Layer 7, in HTML: the inspection panel, a SIBLING of the <svg>
            inside this positioned container (HoverCard.tsx's contract). It
            sets pointer-events:none itself, so it can never steal the hover
            it describes nor interrupt a pan drag. */}
        {hoveredNode === null ? null : (
          <HoverCard
            node={hoveredNode}
            x={hover.x}
            y={hover.y}
            vw={vw}
            vh={vh}
          />
        )}
      </div>
      <StatusBar
        title={doc?.title ?? 'diagram'}
        counts={counts}
        connection={connection}
        lastUpdate={lastUpdate}
        docError={docError}
      />
    </div>
  );
}

const el = document.getElementById('root');
if (!el) throw new Error('missing #root element in index.html');

// ?debug keeps the M2/M3 fixture renderer reachable (fixture test surface).
const debug = new URLSearchParams(window.location.search).has('debug');

createRoot(el).render(
  <StrictMode>{debug ? <DebugCanvas /> : <App />}</StrictMode>,
);
