// render/viewport.ts — fit-to-content viewport math and the useViewport hook
// (spec §8.3, M4 Step 13).
//
// Fit to content on every layout, capped at 120% zoom, animated over 250ms
// so additions feel like the camera pulling back rather than a jump cut.
// Scroll zoom (toward the cursor), space-drag pan and plain left-drag pan
// are allowed.
//
// ALL math lives in pure exported functions so tests need no DOM. The hook
// only wires React state + event listeners around them. Geometry here is
// per-frame view state and is NEVER persisted to the document (spec §1.4).
//
// Panning and hovering are VIEWPORT controls (spec §7), never editing
// (spec §1.6): nothing in this file emits a patch or mutates the document.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

/** Content bounding box in world (layout) coordinates. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Camera: screen = world * scale + (tx, ty). */
export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

/** Breathing room around the fitted content, px (spec §8.3 PAD). */
export const FIT_PAD = 24;
/** Fit never zooms past 120% (spec §8.3). */
export const MAX_FIT_SCALE = 1.2;
/** Scroll-zoom clamp. */
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3;
/** Camera pull-back duration, ms (spec §8.3). */
export const FIT_ANIMATION_MS = 250;
/** Wheel deltaY → zoom factor sensitivity. */
export const WHEEL_SENSITIVITY = 0.0015;

/**
 * Fit-to-content per spec §8.3, verbatim:
 *   scale = min((vw-2*PAD)/w, (vh-2*PAD)/h, 1.2)
 *   tx    = (vw - w*scale)/2 - x*scale
 *   ty    = (vh - h*scale)/2 - y*scale
 * Degenerate bounds (zero size) fall through the min() to the 1.2 cap;
 * a non-positive result (window smaller than 2*PAD) falls back to MIN_SCALE.
 */
export function fitToContent(
  bounds: Bounds,
  vw: number,
  vh: number,
  pad: number = FIT_PAD,
): Viewport {
  let scale = Math.min(
    (vw - 2 * pad) / bounds.width,
    (vh - 2 * pad) / bounds.height,
    MAX_FIT_SCALE,
  );
  if (!Number.isFinite(scale) || scale <= 0) scale = MIN_SCALE;
  const tx = (vw - bounds.width * scale) / 2 - bounds.x * scale;
  const ty = (vh - bounds.height * scale) / 2 - bounds.y * scale;
  return { scale, tx, ty };
}

/** Clamp a scale into the scroll-zoom range. */
export function clampScale(
  scale: number,
  min: number = MIN_SCALE,
  max: number = MAX_SCALE,
): number {
  return Math.min(max, Math.max(min, scale));
}

/** Wheel deltaY → multiplicative zoom factor (scroll up = zoom in). */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * WHEEL_SENSITIVITY);
}

/**
 * Zoom by `factor` toward the cursor at screen position (cx, cy): the world
 * point under the cursor stays under the cursor. Scale is clamped, and the
 * translation is derived from the clamped scale so the invariant holds at
 * the clamp boundary too.
 */
export function zoomAt(
  vp: Viewport,
  cx: number,
  cy: number,
  factor: number,
  min: number = MIN_SCALE,
  max: number = MAX_SCALE,
): Viewport {
  const scale = clampScale(vp.scale * factor, min, max);
  const k = scale / vp.scale;
  return {
    scale,
    tx: cx - (cx - vp.tx) * k,
    ty: cy - (cy - vp.ty) * k,
  };
}

/** Pan by a screen-space delta (space-drag or plain left-drag). */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { scale: vp.scale, tx: vp.tx + dx, ty: vp.ty + dy };
}

// ---------------------------------------------------------------------------
// Drag panning (capability C) — a pure state machine, no DOM.
//
// PAN CONVENTION. The camera is `screen = world * scale + t`. A drag moves the
// translation by the SCREEN delta, so dragging the pointer from A to B adds
// exactly (B - A) to (tx, ty) and the world point that was under the pointer at
// A is under the pointer at B. In world units the content therefore moves by
// (B - A) / scale — the content follows the hand 1:1 on screen at every zoom.
//
// THRESHOLD. A press that never travels more than PAN_THRESHOLD_PX (measured
// from the press origin, not between frames) is not a pan at all: no camera
// movement is emitted and endDrag() reports moved:false, so the click is left
// intact for hovering and for any future click target (spec §1.6 — inspection,
// never editing).
//
// FIT-vs-DRAG RULE (documented, and enforced by the hook):
//   1. pointerdown clears the `animated` flag immediately — before any
//      movement — so the 250ms fit transition is cancelled the moment the user
//      grabs the canvas and the camera cannot keep easing under the hand.
//   2. While a drag is in progress the refit effect is SKIPPED entirely: a
//      document update or window resize mid-drag does not yank the camera away
//      from the user.
//   3. The skipped refit is NOT queued. The camera stays where the user put it
//      until the next bounds- or size-change after the drag ends, which refits
//      normally (animated again). Releasing the mouse never causes a jump.

/** Travel, in screen px from the press origin, before a press becomes a pan. */
export const PAN_THRESHOLD_PX = 3;

/** Which input started the drag. Both pan identically; only the cursor differs. */
export type DragMode = 'space' | 'mouse';

/** In-flight drag. `active` flips true once the movement threshold is passed. */
export interface DragState {
  /** Pointer position at pointerdown (screen px). */
  originX: number;
  originY: number;
  /** Last pointer position already applied to the camera (screen px). */
  lastX: number;
  lastY: number;
  /** True once the press travelled past PAN_THRESHOLD_PX — a real pan. */
  active: boolean;
  mode: DragMode;
  pointerId: number;
}

/** Start a drag at a screen position. Nothing pans yet (below threshold). */
export function beginDrag(
  x: number,
  y: number,
  mode: DragMode = 'mouse',
  pointerId = 0,
): DragState {
  return { originX: x, originY: y, lastX: x, lastY: y, active: false, mode, pointerId };
}

/** Straight-line travel of the pointer from the press origin, in screen px. */
export function dragDistance(d: DragState, x: number, y: number): number {
  return Math.hypot(x - d.originX, y - d.originY);
}

/**
 * Advance a drag to a new pointer position.
 *
 * Returns the next state and the screen-space delta to feed `panBy`. Below the
 * threshold the delta is (0, 0) and the state is unchanged — the press is still
 * a candidate click. On the move that crosses the threshold the delta is the
 * FULL travel since the press origin, so the total translation over a drag from
 * A to B is exactly (B - A) with no swallowed pixels.
 */
export function advanceDrag(
  d: DragState,
  x: number,
  y: number,
): { drag: DragState; dx: number; dy: number } {
  if (!d.active && dragDistance(d, x, y) <= PAN_THRESHOLD_PX) {
    return { drag: d, dx: 0, dy: 0 };
  }
  return {
    drag: { ...d, lastX: x, lastY: y, active: true },
    dx: x - d.lastX,
    dy: y - d.lastY,
  };
}

/** Apply a pointer move straight to a camera. Convenience over advanceDrag. */
export function dragPan(
  vp: Viewport,
  d: DragState,
  x: number,
  y: number,
): { vp: Viewport; drag: DragState } {
  const { drag, dx, dy } = advanceDrag(d, x, y);
  return { vp: dx === 0 && dy === 0 ? vp : panBy(vp, dx, dy), drag };
}

/**
 * End a drag. `moved` says whether it ever became a pan; false means the press
 * was a click and must not be swallowed. The state machine returns to idle
 * (drag === null).
 */
export function endDrag(d: DragState | null): { drag: null; moved: boolean } {
  return { drag: null, moved: d !== null && d.active };
}

/**
 * Cursor for the canvas. The canvas is always grabbable now that plain
 * left-drag pans, so 'grab' is the resting cursor and 'grabbing' shows while a
 * press is held (from pointerdown, not only past the threshold — the hand has
 * the canvas either way).
 */
export function panCursor(dragging: boolean): 'grab' | 'grabbing' {
  return dragging ? 'grabbing' : 'grab';
}

/** SVG/CSS transform string for the camera. */
export function viewportTransform(vp: Viewport): string {
  return `translate(${vp.tx}px, ${vp.ty}px) scale(${vp.scale})`;
}

export function boundsEqual(a: Bounds | null, b: Bounds | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export interface UseViewportResult {
  vp: Viewport;
  /** True while the camera is easing to a new fit (250ms pull-back). */
  animated: boolean;
  /** Space bar currently held (show a grab cursor). */
  spaceHeld: boolean;
  /** A drag (space or plain left-drag) is in progress. */
  panning: boolean;
  /** Canvas cursor: 'grabbing' while a press is held, 'grab' at rest. */
  cursor: 'grab' | 'grabbing';
  /** CSS `transform` value for the camera element. */
  transform: string;
  /** Style for the camera element: transform + 250ms transition when fitting. */
  style: CSSProperties;
  /** Attach to the viewport container: adds a non-passive native wheel listener. */
  containerRef: (el: Element | null) => void;
  onPointerDown: (e: ReactPointerEvent<Element>) => void;
  onPointerMove: (e: ReactPointerEvent<Element>) => void;
  onPointerUp: (e: ReactPointerEvent<Element>) => void;
  /** Pointer left the canvas: ends any in-flight drag (same as pointer up). */
  onPointerLeave: (e: ReactPointerEvent<Element>) => void;
}

/**
 * Viewport state for the renderer (spec §8.3):
 * - refits (animated, 250ms) whenever the content bounds or window size change;
 * - wheel zooms toward the cursor (native non-passive listener, because React
 *   attaches root wheel listeners passively and preventDefault would be lost);
 * - space + drag pans, and so does a plain left-drag on the canvas background.
 * User interaction cancels the animation flag so zoom/pan track the pointer
 * 1:1; the next bounds change re-enables the eased pull-back. A refit that
 * would land mid-drag is skipped, not queued (see the FIT-vs-DRAG RULE above).
 */
export function useViewport(
  bounds: Bounds | null,
  vw: number,
  vh: number,
): UseViewportResult {
  const [vp, setVp] = useState<Viewport>({ scale: 1, tx: 0, ty: 0 });
  const [animated, setAnimated] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  const spaceRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);

  const bx = bounds?.x;
  const by = bounds?.y;
  const bw = bounds?.width;
  const bh = bounds?.height;

  // Refit on every content-bounds or window-size change (spec §8.3).
  useEffect(() => {
    if (bx === undefined || by === undefined || bw === undefined || bh === undefined) return;
    if (vw <= 0 || vh <= 0) return;
    // FIT-vs-DRAG rule 2: never re-fit under a dragging hand. Not queued —
    // the next bounds/size change after the drag ends fits normally (rule 3).
    if (dragRef.current !== null) return;
    setVp(fitToContent({ x: bx, y: by, width: bw, height: bh }, vw, vh));
    setAnimated(true);
  }, [bx, by, bw, bh, vw, vh]);

  // Space key tracking for pan mode.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      e.preventDefault(); // keep the page from scrolling
      spaceRef.current = true;
      setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      setSpaceHeld(false);
      // Releasing space ends a space-drag; a plain left-drag that happens to
      // overlap a space press keeps going until the button comes up.
      if (dragRef.current?.mode === 'space') {
        dragRef.current = null;
        setPanning(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Native wheel listener (passive: false) so preventDefault works.
  const containerRef = useCallback((el: Element | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    if (el === null) return;
    const onWheel = (ev: Event) => {
      const we = ev as WheelEvent;
      we.preventDefault();
      const r = el.getBoundingClientRect();
      setAnimated(false);
      setVp((prev) =>
        zoomAt(prev, we.clientX - r.left, we.clientY - r.top, wheelZoomFactor(we.deltaY)),
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    wheelCleanupRef.current = () => el.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => () => wheelCleanupRef.current?.(), []);

  const onPointerDown = useCallback((e: ReactPointerEvent<Element>) => {
    // Space-drag (any button) or plain left-drag on the canvas background.
    // Middle/right buttons are left to the browser.
    const space = spaceRef.current;
    if (!space && e.button !== 0) return;
    dragRef.current = beginDrag(
      e.clientX,
      e.clientY,
      space ? 'space' : 'mouse',
      e.pointerId,
    );
    setPanning(true);
    // FIT-vs-DRAG rule 1: kill the 250ms transition the instant the user grabs.
    setAnimated(false);
    const t = e.currentTarget as Element & { setPointerCapture?: (id: number) => void };
    if (typeof t.setPointerCapture === 'function') t.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<Element>) => {
    const from = dragRef.current;
    if (from === null) return;
    const { drag, dx, dy } = advanceDrag(from, e.clientX, e.clientY);
    dragRef.current = drag;
    if (dx === 0 && dy === 0) return; // still under the click threshold
    setAnimated(false);
    setVp((prev) => panBy(prev, dx, dy));
  }, []);

  const onPointerUp = useCallback(() => {
    // moved === false means this press was a click: nothing panned, so the
    // click is left for hover/selection handlers downstream.
    dragRef.current = endDrag(dragRef.current).drag;
    setPanning(false);
  }, []);

  const transform = viewportTransform(vp);
  const style: CSSProperties = {
    transform,
    transformOrigin: '0 0',
    transition: animated ? `transform ${FIT_ANIMATION_MS}ms ease` : 'none',
  };

  return {
    vp,
    animated,
    spaceHeld,
    panning,
    cursor: panCursor(panning),
    transform,
    style,
    containerRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave: onPointerUp,
  };
}
