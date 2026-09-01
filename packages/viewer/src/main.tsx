// main.tsx — the PRODUCT viewer app (spec §8, §9; M4+M5 integration).
//
// Data flow, once per document:
//
//   diagram serve ──ws {type:'doc'}──▶ connectViewer (ws.ts)
//        └▶ deriveView(doc, collapsed)           §7 collapse-and-merge
//        └▶ LayoutClient.request(derived)        §5.4 protocol, stale-discard
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
//
// SAVING (M7, §8.4's ⌘S). [SVG ⌘S] and [PNG 2×] in the status strip serialise
// the frame ALREADY ON SCREEN through the same emitter `diagram export svg`
// uses (export/save.ts), so the saved file and the picture cannot differ —
// collapse included. Read-only, like the view buttons: no write, no socket
// traffic, nothing in .diagram/.
//
// VIEWS (M7). Everything downstream of the socket draws the DERIVED document,
// never the stored one: deriveView() is applied exactly once, at the top of
// the pipeline, so layout, hop geometry, the renderer and the hover panel all
// see the same node and edge set and a collapsed group is simply a node like
// any other. Which ids are collapsed comes from useViewOverride — a LOCAL
// override seeded from doc.collapsed that the status-bar buttons change and
// that resets whenever the agent changes doc.collapsed. Nothing in this file
// writes to the document; see view/viewState.ts for the §1.6 argument.
//
// ANALYSIS OVERLAYS (M9, §15.5 and §18.7). Two more status-bar buttons put a
// lens over the picture: [analysis] rings chokepoints and highlights the
// longest synchronous chain, [blast: X] rings one component and tints what
// depends on it. Same class of control as the view buttons — local, read-only,
// no patch, no socket traffic (§7, §1.6) — and the same split: the rules are
// pure functions in view/overlayState.ts and view/overlayPlan.ts, this file is
// wiring.
//
// TWO THINGS THIS FILE OWNS ABOUT THEM.
//
//  1. THE ANALYSIS RUNS ON THE FULL DOCUMENT (A2), the canvas draws the
//     DERIVED one, and `frame` now carries BOTH plus deriveView's merge
//     bookkeeping. That is why deriveViewDetail replaced deriveView here.
//     Everything the overlay says is projected from the full-document answer
//     onto the ids actually on screen, and what the projection loses is
//     counted and printed in the caption rather than silently dropped.
//
//  2. THE OVERLAY IS COMPUTED AGAINST THE PAINTED FRAME, not the newest
//     document. Layout is asynchronous, so during the gap the newest document
//     describes a picture that is not on screen yet; ringing boxes from it
//     would put a ring on the wrong box for a frame. Taking `frame.source`
//     and `frame.detail` as the overlay's inputs makes the lens and the
//     picture the same age by construction.
//
// The overlay is deliberately NOT part of the saved SVG (export/save.ts): the
// file is the diagram, and a lens someone toggled on in one tab is not.

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { GNode, GraphDoc } from '@diagram-engine/core';
// Runtime import of the core SOURCE module rather than the '@diagram-engine/core'
// barrel — deliberately, and permanently: the barrel re-exports store/, which
// pulls node:fs into the browser bundle. Same route toSvg.ts and NodeBox.tsx
// take, for the same reason.
import { deriveViewDetail, type DerivedView } from '../../core/src/view/derive.js';
import { DebugCanvas } from './debug/DebugCanvas.js';
import { frameToSvg, isSaveShortcut, savePng, saveSvg } from './export/save.js';
import { composeFramePaths } from './geometry/index.js';
import { elkWithOwnWorker } from './layout/elkBrowser.js';
import type { LaidOut, Rect } from './layout/fromElk.js';
import {
  LayoutClient,
  handleLayoutRequest,
  type LayoutRequest,
  type WorkerLike,
} from './layout/worker.js';
import { overlayFor } from './render/AnalysisOverlay.js';
import { Canvas } from './render/Canvas.js';
import { editorSchemeFrom } from './render/bindingLink.js';
import { HoverCard } from './render/HoverCard.js';
import { OverlayButtons } from './render/OverlayButtons.js';
import {
  OverlayCaption,
  analysisCaption,
  blastCaption,
  type Caption,
} from './render/OverlayCaption.js';
import { BAR_HEIGHT, StatusBar, type DocError } from './render/StatusBar.js';
import { SIDEBAR_WIDTH, Sidebar } from './render/Sidebar.js';
import { SaveButtons } from './render/SaveButtons.js';
import { theme } from './render/theme.js';
import { ViewButtons } from './render/ViewButtons.js';
import { useViewport } from './render/viewport.js';
import { analysisPlan, blastPlan } from './view/overlayPlan.js';
import { buildDrawnIndex } from './view/overlayState.js';
import { useOverlay } from './view/useOverlay.js';
import { useViewOverride } from './view/useViewOverride.js';
import { connectViewer, type ConnectionState } from './live.js';

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
  /** The DERIVED document — what is drawn (§7). */
  doc: GraphDoc;
  /**
   * The FULL document it was derived from. The analysis overlays run on this
   * one and only this one (A2), and holding it on the frame is what keeps the
   * lens exactly as old as the picture (header note 2).
   */
  source: GraphDoc;
  /** deriveView's own bookkeeping: what it hid, and which edges it merged. */
  detail: DerivedView;
  laidOut: LaidOut;
  /** Composed edge paths, index-aligned with laidOut.edges. */
  paths: string[];
}

/** The pair one layout request is made from: the full doc and its derived view. */
interface Pending {
  source: GraphDoc;
  detail: DerivedView;
}

/**
 * One crossing pass for the whole frame (§6.2/§6.8): hops are detected
 * against the segments of ALL edges at once and guarded against NODE rects
 * only — groups are containers, not obstacles.
 */
function buildFrame(pending: Pending, laidOut: LaidOut): Frame {
  const doc = pending.detail.doc;
  const nodeRects: Rect[] = doc.nodes.flatMap((n) => {
    const r = laidOut.nodes.get(n.id);
    return r ? [r] : [];
  });
  return {
    doc,
    source: pending.source,
    detail: pending.detail,
    laidOut,
    paths: composeFramePaths(laidOut.edges, nodeRects),
  };
}

/**
 * Window size minus the status strip AND the sidebar, tracked for
 * fit-to-content (§8.3). The panel takes width away from the canvas rather
 * than floating over it: fit-to-content has to fit the space the diagram
 * actually has, or opening the panel would push half the picture underneath
 * it. `panelWidth` is 0 while the panel is shut, and changing it re-fits.
 */
function useCanvasSize(panelWidth: number): { vw: number; vh: number } {
  const read = (): { vw: number; vh: number } =>
    typeof window === 'undefined'
      ? { vw: 0, vh: 0 }
      : {
          vw: Math.max(0, window.innerWidth - panelWidth),
          vh: Math.max(0, window.innerHeight - BAR_HEIGHT),
        };
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = (): void => setSize(read());
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, [panelWidth]);
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

/**
 * How long the card survives the pointer leaving a node.
 *
 * It was one animation frame, which was enough for the box→text micro-leave
 * Canvas emits and for nothing else. A card whose binding chips are LINKS
 * (P5-03) has to be reachable: the card sits 14px off the cursor and follows
 * it while the pointer is over the node, so the only moment it stands still is
 * after the leave. Under 200ms it cannot be caught; far above it, a card
 * lingers over a diagram nobody is pointing at.
 */
const HOVER_LEAVE_MS = 220;

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
  holdCard: () => void;
  releaseCard: () => void;
} {
  const [hover, setHover] = useState<HoverState>({ id: null, x: 0, y: 0 });
  const elRef = useRef<HTMLDivElement | null>(null);
  const ptRef = useRef({ x: 0, y: 0 });
  const moveRaf = useRef<number | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);
  const panningRef = useRef(panning);
  panningRef.current = panning;

  const cancelLeave = useCallback(() => {
    if (leaveTimer.current === null) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);

  // A drag owns the pointer: drop the card the moment a pan starts.
  useEffect(() => {
    if (!panning) return;
    cancelLeave();
    heldRef.current = false;
    setHover((h) => (h.id === null ? h : { ...h, id: null }));
  }, [panning, cancelLeave]);

  useEffect(
    () => () => {
      if (moveRaf.current !== null) cancelAnimationFrame(moveRaf.current);
      if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    },
    [],
  );

  const onHoverNode = useCallback(
    (id: string | null) => {
      if (id === null) {
        cancelLeave();
        // The pointer is HELD on a binding chip: the card is being used, not
        // left behind, and dropping it now would cancel the click it is in the
        // middle of receiving.
        if (heldRef.current) return;
        leaveTimer.current = setTimeout(() => {
          leaveTimer.current = null;
          setHover((h) => (h.id === null ? h : { ...h, id: null }));
        }, HOVER_LEAVE_MS);
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

  // Rule 4: a card with a LINK in it has to be reachable. Entering the chips
  // row pins the card open; leaving it drops the card at once, so nothing
  // lingers over the diagram after the pointer has gone elsewhere.
  const holdCard = useCallback(() => {
    heldRef.current = true;
    cancelLeave();
  }, [cancelLeave]);

  const releaseCard = useCallback(() => {
    heldRef.current = false;
    cancelLeave();
    setHover((h) => (h.id === null ? h : { ...h, id: null }));
  }, [cancelLeave]);

  return { hover, onHoverNode, onHoverMove, containerRef, holdCard, releaseCard };
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
  // The project root a repo-relative binding ref resolves against (§3.8).
  // Null until a server that reports one has sent a document — then a binding
  // chip is plain text rather than a link pointing at a guessed path.
  const [root, setRoot] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('reconnecting');
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  // A rejected graph.json (§9). Never touches `frame` — the last good
  // diagram stays on screen; only the status bar goes amber.
  const [docError, setDocError] = useState<DocError | null>(null);

  const clientRef = useRef<LayoutClient | null>(null);
  // The doc belonging to the LATEST request; LayoutClient only ever delivers
  // the latest response, so pairing through this ref is safe (§5.4).
  const pendingDocRef = useRef<Pending | null>(null);

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
      onDoc: (next, nextRoot) => {
        setDoc(next);
        // The project root binding chips resolve against (§3.8, P5-03). It
        // arrives with the document because only the server knows it.
        setRoot(nextRoot);
        setLastUpdate(Date.now());
        setDocError(null); // a good doc clears the amber
        // Laying it out is NOT done here: the drawn document depends on the
        // collapsed list as well as on the document, so one effect below owns
        // the request for both inputs and there is no second code path when a
        // view button (rather than a patch) changes the picture.
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

  // The local view override (§7): seeded from doc.collapsed, changed only by
  // the status-bar buttons, reset whenever the agent changes doc.collapsed.
  const views = useViewOverride(doc);

  // The document that is actually DRAWN (§7). Memoised on the collapsed KEY
  // rather than the array so a re-render for an unrelated reason — a hover, a
  // pan, the "Xs ago" tick — cannot trigger a fresh layout.
  // (views.key deliberately stands in for views.collapsed in the deps.)
  const detail = useMemo(
    () => (doc === null ? null : deriveViewDetail(doc, views.collapsed)),
    [doc, views.key],
  );
  const derived = detail?.doc ?? null;

  // One place requests layout, for both causes (a new document, a new view).
  useEffect(() => {
    const client = clientRef.current;
    if (client === null) return;
    if (
      doc === null ||
      detail === null ||
      derived === null ||
      (derived.nodes.length === 0 && derived.groups.length === 0)
    ) {
      // Nothing to lay out; drop the stale frame so the hint shows.
      pendingDocRef.current = null;
      setFrame(null);
      return;
    }
    pendingDocRef.current = { source: doc, detail };
    client.request(derived);
  }, [doc, detail, derived]);

  // The panel is open by default: its whole reason to exist is that the levels
  // of a nested diagram are invisible until something lists them.
  const [panelOpen, setPanelOpen] = useState(true);
  const panelWidth = panelOpen ? SIDEBAR_WIDTH : 0;
  const { vw, vh } = useCanvasSize(panelWidth);
  const bounds = useMemo(
    () =>
      frame === null
        ? null
        : { x: 0, y: 0, width: frame.laidOut.width, height: frame.laidOut.height },
    [frame],
  );
  const view = useViewport(bounds, vw, vh);

  // Counts describe WHAT IS ON SCREEN, so they follow the derived document:
  // saying "11 nodes" over an exec view showing three boxes would describe a
  // picture the reader cannot see. With nothing collapsed the two are equal,
  // which is the common case.
  const shown = derived ?? doc;
  const counts = {
    nodes: shown?.nodes.length ?? 0,
    groups: shown?.groups.length ?? 0,
    edges: shown?.edges.length ?? 0,
  };

  // --- the analysis overlays (§15.5, §18.7) -------------------------------
  // Every input comes off the PAINTED frame (header note 2), so the lens and
  // the picture cannot disagree about which boxes exist. `source` is the full
  // document — the only thing `analyse` and `blastRadius` are ever handed
  // (A2) — and `detail` is deriveView's merge map, which is how a finding
  // about a hidden edge still lights up the merged edge that replaced it.
  const drawnIndex = useMemo(
    () => buildDrawnIndex(frame?.source ?? null, frame?.detail ?? null),
    [frame],
  );
  const overlay = useOverlay(frame?.source ?? null, drawnIndex);

  const analysisView = useMemo(
    () =>
      frame === null || overlay.analysis === null
        ? null
        : analysisPlan(frame.source, overlay.analysis, drawnIndex),
    [frame, overlay.analysis, drawnIndex],
  );
  // `hiddenTargets` travels with the plan so the caption can say that a
  // selected target took no part in the prediction. It is NOT re-projected
  // onto its collapsed ancestor: that would ring the wrong box and assert the
  // wrong experiment (overlayPlan decision 4). Saying it is the fix.
  const hiddenTargetCount = overlay.hiddenTargets.length;
  const blastView = useMemo(
    () =>
      overlay.blast === null
        ? null
        : blastPlan(overlay.blast, drawnIndex, { hiddenTargets: hiddenTargetCount }),
    [overlay.blast, drawnIndex, hiddenTargetCount],
  );

  // §18.7's click-to-target. Three guards, in order, and none of them is a
  // new rule:
  //   * the mode. A click means nothing in the plain picture; toggleTarget is
  //     a no-op outside `blast` and says so in overlayState.ts.
  //   * the pan. A drag that starts and ends over the same box still fires a
  //     click; useViewport already distinguishes the two (PAN_THRESHOLD_PX),
  //     so the answer is asked for, not re-derived.
  //   * nothing else. It sets React state in this tab: no patch, no write,
  //     no socket send. The socket stays receive-only.
  const onNodeClick = useCallback(
    (id: string, opts: { toggle: boolean }) => {
      if (view.didPan()) return;
      overlay.toggleTarget(id, { extend: opts.toggle });
    },
    [view, overlay],
  );

  // Escape clears the whole selection — one gesture out, whether one target
  // is chosen or eight (§18.7). It is deliberately not bound to a background
  // click: the background is the pan surface, and a clear you can trigger by
  // releasing a drag a pixel short of the threshold is a clear you cannot
  // trust. The caption names the key wherever the selection is empty.
  const clearTargets = overlay.clearTargets;
  const blastOn = overlay.mode === 'blast';
  useEffect(() => {
    if (typeof window === 'undefined' || !blastOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      clearTargets();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Bound only while the overlay is on: with it off there is no selection
    // on screen, so an Escape means something to some other part of the page
    // and must not silently wipe the target waiting to be returned to.
  }, [blastOn, clearTargets]);

  const overlaySvg =
    frame === null
      ? null
      : overlayFor(overlay.mode, analysisView, blastView, {
          laidOut: frame.laidOut,
          paths: frame.paths,
          nodeIds: frame.doc.nodes.map((n) => n.id),
        });

  // The caption is not decoration: A4, A5, C2 and C3 are printed from it,
  // verbatim, in core's own words. See render/OverlayCaption.tsx.
  const caption: Caption | null =
    overlay.analysis !== null && analysisView !== null
      ? analysisCaption(overlay.analysis, analysisView)
      : overlay.blast !== null && blastView !== null
        ? blastCaption(overlay.blast, blastView)
        : null;

  // Saving (§8.4). The frame is serialised as-is — no re-layout, no second
  // renderer — so what lands on disk is what is on screen.
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;

  const onSaveSvg = useCallback(() => {
    const f = frameRef.current;
    if (f === null) return;
    try {
      setSaveError(null);
      saveSvg(frameToSvg(f.doc, f.laidOut, f.paths));
    } catch (e) {
      setSaveError(`could not save the SVG: ${(e as Error).message}`);
    }
  }, []);

  const onSavePng = useCallback(() => {
    const f = frameRef.current;
    if (f === null) return;
    setSaveError(null);
    setSaveBusy(true);
    savePng(frameToSvg(f.doc, f.laidOut, f.paths))
      .catch((e: Error) => setSaveError(`could not save the PNG: ${e.message}`))
      .finally(() => setSaveBusy(false));
  }, []);

  // ⌘S / Ctrl-S saves the SVG, and preventDefault stops the browser's own
  // "save this page" dialog — which would offer the HTML shell, not the
  // diagram. Only ever intercepted when there is a frame to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isSaveShortcut(e) || frameRef.current === null) return;
      e.preventDefault();
      onSaveSvg();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSaveSvg]);

  // Capability B. The hovered id is resolved against the CURRENT frame, so a
  // document update that removes the node simply closes the card.
  const hoverApi = useHover(view.panning);
  // Which URL scheme a binding chip opens with: `?editor=idea` on the viewer
  // URL, vscode by default. Read once — it is a property of how the page was
  // opened, not of the document.
  const editor = useMemo(
    () => editorSchemeFrom(typeof location === 'undefined' ? '' : location.search),
    [],
  );
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
          left: panelWidth,
          right: 0,
          top: 0,
          bottom: BAR_HEIGHT,
          overflow: 'hidden',
          // 'grab' at rest / 'grabbing' while held — plain left-drag pans
          // the canvas (capability C), space-drag still does too. Over a box
          // with the blast overlay on it becomes 'pointer': that click selects
          // a target (§18.7), and the affordance has to exist where the click
          // does. Never while actually panning, where the hand wins.
          cursor:
            view.cursor === 'grab' && overlay.mode === 'blast' && hoveredNode !== null
              ? 'pointer'
              : view.cursor,
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
                // §18.7: click a node to target it, modifier-click to
                // combine. A lens over one tab, never an edit (§1.6).
                onNodeClick={overlay.mode === 'blast' ? onNodeClick : undefined}
                // A ring means "target" or "contained" while the blast
                // overlay is on, so the hover ring stands down — see Canvas.
                hoverRing={overlay.mode !== 'blast'}
                // Layer 7 (§8.1), above everything and never hit-tested —
                // the slot Canvas already exposes, so nothing about layers
                // 1-6 changes and the overlay-off picture is untouched.
                hoverOverlay={overlaySvg ?? undefined}
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
            root={root}
            editor={editor}
            onChipsEnter={hoverApi.holdCard}
            onChipsLeave={hoverApi.releaseCard}
          />
        )}
        {/* The overlay's caption: HTML, fixed to the container, so it cannot
            be panned or zoomed off the screenshot someone pastes into a
            decision. It carries the A4/A5/C2/C3 sentences verbatim. */}
        {caption === null ? null : <OverlayCaption caption={caption} />}
      </div>
      {panelOpen ? (
        <Sidebar
          depths={views.depths}
          activeDepth={views.depth}
          onSelectDepth={views.selectDepth}
          containers={views.containers}
          onToggleContainer={views.toggleContainer}
          onRevealContainer={views.revealContainer}
          onSelectContainer={views.selectContainer}
          selectedCount={views.selectedCount}
          onClearSelection={views.clearSelection}
          followingDocument={views.followingDocument}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
      <StatusBar
        title={doc?.title ?? 'diagram'}
        counts={counts}
        connection={connection}
        lastUpdate={lastUpdate}
        docError={docError}
        viewSummary={views.summary}
        panel={
          <button
            type="button"
            data-testid="panel-toggle"
            aria-expanded={panelOpen}
            aria-label="View controls"
            title={panelOpen ? 'Hide the view panel' : 'Show the view panel'}
            onClick={() => setPanelOpen((open) => !open)}
            style={{
              font: 'inherit',
              lineHeight: 1,
              padding: '3px 7px',
              borderRadius: 4,
              cursor: 'pointer',
              background: panelOpen ? theme.text.primary : 'transparent',
              border: `1px solid ${panelOpen ? theme.text.primary : theme.node.stroke}`,
              color: panelOpen ? theme.canvas : theme.text.secondary,
            }}
          >
            ☰
          </button>
        }
        views={
          <ViewButtons
            active={views.active}
            focusLabel={views.focusLabel}
            focusEnabled={views.focusEnabled}
            onSelect={views.select}
          />
        }
        analysis={
          <OverlayButtons
            mode={overlay.mode}
            targetLabel={overlay.targetLabel}
            blastEnabled={overlay.blastEnabled}
            onSelect={overlay.select}
          />
        }
        save={
          <SaveButtons
            onSaveSvg={onSaveSvg}
            onSavePng={onSavePng}
            enabled={frame !== null}
            busy={saveBusy}
            error={saveError}
          />
        }
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
