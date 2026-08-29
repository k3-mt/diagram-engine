// render/viewport.ts — fit-to-content viewport math and the useViewport hook
// (spec §8.3, M4 Step 13).
//
// Fit to content on every layout, capped at 120% zoom, animated over 250ms
// so additions feel like the camera pulling back rather than a jump cut.
// Scroll zoom (toward the cursor) and space-drag pan are allowed.
//
// ALL math lives in pure exported functions so tests need no DOM. The hook
// only wires React state + event listeners around them. Geometry here is
// per-frame view state and is NEVER persisted to the document (spec §1.4).

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

/** Pan by a screen-space delta (space-drag). */
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { scale: vp.scale, tx: vp.tx + dx, ty: vp.ty + dy };
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
  /** A space-drag is in progress (show a grabbing cursor). */
  panning: boolean;
  /** CSS `transform` value for the camera element. */
  transform: string;
  /** Style for the camera element: transform + 250ms transition when fitting. */
  style: CSSProperties;
  /** Attach to the viewport container: adds a non-passive native wheel listener. */
  containerRef: (el: Element | null) => void;
  onPointerDown: (e: ReactPointerEvent<Element>) => void;
  onPointerMove: (e: ReactPointerEvent<Element>) => void;
  onPointerUp: (e: ReactPointerEvent<Element>) => void;
}

/**
 * Viewport state for the renderer (spec §8.3):
 * - refits (animated, 250ms) whenever the content bounds or window size change;
 * - wheel zooms toward the cursor (native non-passive listener, because React
 *   attaches root wheel listeners passively and preventDefault would be lost);
 * - space + drag pans.
 * User interaction cancels the animation flag so zoom/pan track the pointer
 * 1:1; the next bounds change re-enables the eased pull-back.
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
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);

  const bx = bounds?.x;
  const by = bounds?.y;
  const bw = bounds?.width;
  const bh = bounds?.height;

  // Refit on every content-bounds or window-size change (spec §8.3).
  useEffect(() => {
    if (bx === undefined || by === undefined || bw === undefined || bh === undefined) return;
    if (vw <= 0 || vh <= 0) return;
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
      dragRef.current = null;
      setSpaceHeld(false);
      setPanning(false);
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
    if (!spaceRef.current) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setPanning(true);
    const t = e.currentTarget as Element & { setPointerCapture?: (id: number) => void };
    if (typeof t.setPointerCapture === 'function') t.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<Element>) => {
    const from = dragRef.current;
    if (from === null) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setAnimated(false);
    setVp((prev) => panBy(prev, dx, dy));
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
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
    transform,
    style,
    containerRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
