// render/Canvas.tsx — the product renderer's frame composer (spec §8.1).
//
// Z-order is STRICT and global — every element of a layer is drawn before
// any element of the next:
//
//   1. group rectangles, outermost first
//   2. group labels
//   3. edge paths
//   4. edge labels, each with a halo rect in the canvas colour
//   5. node boxes
//   6. node icons and labels
//   7. the hover layer (capability B) — a highlight ring around the
//      hovered node, above everything. Optional: absent unless the parent
//      passes `hoveredId`. Layers 1–6 are untouched by it.
//
// EMPHASIS (§8.7) is the one thing that DOES reach into layers 3–6: when the
// parent names a set of nodes and a set of edges, everything outside them is
// drawn at a reduced opacity, and the named EDGES are drawn lit, in a colour
// the parent chooses per edge.
//
// The lit edge is drawn by the edge itself, in layer 3, NOT as a second heavy
// stroke in the overlay layer. That was the first attempt: layer 7 sits above
// the edge labels and above an edge's own step badge, so the stroke meant to
// highlight a connection was painted straight through the number and the
// words on it. Lighting the edge in place keeps §8.1's z-order for free.
//
// Emphasis changes no position, no z-order and no markup for the elements it
// does not touch, and with no emphasis set the frame is emitted
// byte-identically to how it always was.
//
// Nodes above edges means an edge clipping a node corner is hidden, not
// drawn across it.
//
// Canvas renders a <g>, not an <svg>: the parent owns the <svg> element and
// the viewport transform (§8.3), and passes it in via `transform`.
//
// Edge `d` strings are computed ONCE per frame by composeFramePaths and
// handed in as `paths` (aligned index-for-index with `laidOut.edges`) —
// crossing detection is O(h×v) over the whole frame and must never run per
// edge. Geometry is never persisted to the document (§1.4).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEventHandler, ReactNode } from 'react';
import type { GEdge, GNode, GraphDoc } from '@diagram-engine/core';
import type { LaidOut, Rect } from '../layout/fromElk.js';
import {
  EdgeLabel,
  EdgePath,
  ArrowMarker,
  CrowManyMarker,
  CrowOneMarker,
  ReturnMarker,
} from './EdgePath.js';
import { EntityBox, EntityContent, isEntityTable } from './EntityBox.js';
import { GroupLabel, GroupRect } from './GroupRect.js';
import { NodeBox, NodeContent, type HoverHandlers } from './NodeBox.js';
import { theme } from './theme.js';

/** Cross-fade duration between successive layouts (§8.3). */
export const CROSSFADE_MS = 150;

/** Name of the injected fade keyframes. */
const FADE_ANIM = 'de-frame-fade';

/**
 * Hover wiring (capability B) — INSPECTION ONLY: these callbacks report
 * what the pointer is over, and nothing here may ever patch the document
 * (§1.6). All optional; omitted, the canvas renders exactly as before.
 *
 * The panel itself (HoverCard.tsx) is HTML and is rendered by the PARENT
 * as a sibling of the <svg> — see the interface note at the top of
 * HoverCard.tsx. Canvas contributes the seventh SVG layer: the highlight
 * ring on the hovered node, plus anything the parent injects through
 * `hoverOverlay`.
 */
export interface HoverProps {
  /** id of the node the pointer is over, from the parent's state. */
  hoveredId?: string | null;
  /** Called with a node id on enter and null on leave. */
  onHoverNode?: (id: string | null) => void;
  /** Raw move events on a node group, for tracking the cursor position. */
  onHoverMove?: MouseEventHandler<SVGGElement>;
  /**
   * Click on a node group (§18.7 — click a node to target the blast radius).
   * `toggle` is true when a multi-select modifier was held.
   *
   * This is a LENS, not an edit: it can only change which prediction this tab
   * draws (§7, §1.6). Canvas hands the id and the modifier up and decides
   * nothing itself — including whether the press was really a click, which
   * only the viewport's drag state machine knows (viewport.ts PAN_THRESHOLD_PX).
   */
  onNodeClick?: (id: string, opts: { toggle: boolean }) => void;
  /**
   * Draw the hover ring? Default true.
   *
   * False while the blast overlay is on. There a ring is the vocabulary for
   * "this box is a target" (accent, pad 4) or "contained" (dashed ink, pad 4),
   * and the hover ring is a third ring one pixel inside the first, in a third
   * hue — so moving the pointer across the diagram painted a target-looking
   * ring on every box in turn, and a box that really was a target wore two
   * concentric rings a pixel apart. A ring keeps one meaning; the pointer
   * cursor carries the clickability instead.
   */
  hoverRing?: boolean;
  /** Extra SVG the parent wants painted in the hover layer. */
  hoverOverlay?: ReactNode;
  /**
   * What to keep at full strength (§8.7). Everything else — edges, edge
   * labels, node boxes, node content — is drawn at `emphasis.dim`.
   *
   * GROUPS ARE NEVER DIMMED. A boundary is the answer to "where does this
   * thing live", which is exactly what the reader is asking when they click a
   * box; fading the vpc around the selected node would remove the context the
   * selection exists to give.
   *
   * Null or absent means no emphasis, and the markup is unchanged.
   */
  emphasis?: Emphasis | null;
}

/** What to keep lit, in what colour, and how far to fade the rest. */
export interface Emphasis {
  nodes: ReadonlySet<string>;
  /**
   * Edge id -> the colour to draw it in. A map rather than a set because the
   * two directions of a selection are told apart by hue (see
   * SelectionOverlay), and Canvas has no business knowing which is which — it
   * is handed the answer.
   */
  edges: ReadonlyMap<string, string>;
  /** Opacity for everything outside the sets, 0–1. */
  dim: number;
}

export interface CanvasProps extends HoverProps {
  doc: GraphDoc;
  laidOut: LaidOut;
  /** Composed edge paths, index-aligned with `laidOut.edges`. */
  paths: string[];
  /** Viewport transform from the parent (§8.3), e.g. "translate(x,y) scale(s)". */
  transform?: string;
}

/**
 * True on macOS-family platforms, where ctrl+left-click is the system
 * context-menu gesture and must not double as the extend-selection chord.
 * Read once — it cannot change under a running page — and defensively, since
 * the module is also imported by the SSR/SVG export path where there is no
 * navigator.
 */
const APPLE = /* @__PURE__ */ (() => {
  const nav: { platform?: string; userAgent?: string } | undefined =
    typeof navigator === 'undefined' ? undefined : navigator;
  return /Mac|iPhone|iPad|iPod/.test(nav?.platform ?? nav?.userAgent ?? '');
})();

/** The platform's extend-selection chord (see FrameLayers). */
export function extendChord(e: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return e.shiftKey || (APPLE ? e.metaKey : e.ctrlKey);
}

/** Stroke width of the hover highlight ring. */
export const HOVER_RING_W = 2;
/** How far the ring sits outside the node box, px. */
export const HOVER_RING_PAD = 3;

interface Frame {
  doc: GraphDoc;
  laidOut: LaidOut;
  paths: string[];
}

/** Depth of a group in the group-parent chain (0 = top-level). */
function groupDepth(id: string, parentOf: Map<string, string | null>): number {
  let depth = 0;
  const seen = new Set<string>();
  let p = parentOf.get(id) ?? null;
  while (p !== null && !seen.has(p)) {
    depth++;
    seen.add(p);
    p = parentOf.get(p) ?? null;
  }
  return depth;
}

/** Groups that were laid out, sorted outermost first (§8.1 rule 1). */
function orderedGroups(
  doc: GraphDoc,
  laidOut: LaidOut,
): { group: GraphDoc['groups'][number]; rect: Rect }[] {
  const parentOf = new Map<string, string | null>(
    doc.groups.map((g) => [g.id, g.parent]),
  );
  return doc.groups
    .flatMap((group) => {
      const rect = laidOut.nodes.get(group.id);
      return rect ? [{ group, rect, depth: groupDepth(group.id, parentOf) }] : [];
    })
    .sort((a, b) => a.depth - b.depth) // stable: siblings keep document order
    .map(({ group, rect }) => ({ group, rect }));
}

/** Nodes that were laid out, in document order. */
function placedNodes(
  doc: GraphDoc,
  laidOut: LaidOut,
): { node: GNode; rect: Rect }[] {
  return doc.nodes.flatMap((node) => {
    const rect = laidOut.nodes.get(node.id);
    return rect ? [{ node, rect }] : [];
  });
}

/**
 * Laid-out edges paired with their document entry, composed path and the
 * POLYLINE behind it.
 *
 * The polyline travels alongside the `d` string because §3.9's return leg is
 * derived from it: a `d` string has already had hops and corner arcs baked in
 * and cannot be offset sideways, whereas the polyline is the plain route ELK
 * produced. Handing both down costs nothing — they are the same objects the
 * layout already made — and keeps EdgePath the only place that knows a return
 * leg exists.
 */
function placedEdges(
  doc: GraphDoc,
  laidOut: LaidOut,
  paths: string[],
): {
  edge: GEdge;
  d: string;
  points: LaidOut['edges'][number]['points'];
  label: LaidOut['edges'][number]['label'];
}[] {
  const byId = new Map<string, GEdge>(doc.edges.map((e) => [e.id, e]));
  return laidOut.edges.flatMap((abs, i) => {
    const edge = byId.get(abs.id);
    const d = paths[i];
    if (edge === undefined || d === undefined || d === '') return [];
    return [{ edge, d, points: abs.points, label: abs.label }];
  });
}

/**
 * One frame's z-ordered layers (§8.1) — six always, plus the optional
 * seventh hover layer on top. Pure — no state, no effects.
 */
export function FrameLayers({
  doc,
  laidOut,
  paths,
  hoveredId,
  onHoverNode,
  onHoverMove,
  onNodeClick,
  hoverRing = true,
  hoverOverlay,
  emphasis,
}: Frame & HoverProps): JSX.Element {
  const groups = orderedGroups(doc, laidOut);
  const nodes = placedNodes(doc, laidOut);
  const edges = placedEdges(doc, laidOut, paths);

  // The two dimming tests. Both answer `undefined` when no emphasis is set,
  // and an `opacity` of undefined emits no attribute at all — which is what
  // keeps the un-emphasised frame byte-identical to what it was.
  const nodeOpacity = (id: string): number | undefined =>
    emphasis == null || emphasis.nodes.has(id) ? undefined : emphasis.dim;
  const edgeOpacity = (id: string): number | undefined =>
    emphasis == null || emphasis.edges.has(id) ? undefined : emphasis.dim;
  const edgeLit = (id: string): string | undefined => emphasis?.edges.get(id);

  // Inspection handlers, attached to BOTH node layers so the pointer is
  // tracked over the box and over its text alike. Absent when the parent
  // asked for no hover, and event handlers never serialise, so the
  // emitted markup is unchanged either way.
  // The click rides on the SAME node groups as the hover, and is added to
  // them without touching either — a node with no click handler emits exactly
  // the markup it did before. The extend chord is the platform's own:
  // shift everywhere, plus ⌘ on Apple and Ctrl elsewhere. Ctrl is NOT accepted
  // on macOS, where ctrl+left-click is the system context-menu gesture — the
  // browser would pop a menu over the diagram on the same press that toggled a
  // target. Alt is left alone; the window manager has claims on it.
  const hoverOf = (id: string): HoverHandlers =>
    onHoverNode === undefined && onHoverMove === undefined && onNodeClick === undefined
      ? {}
      : {
          onMouseEnter: onHoverNode === undefined ? undefined : () => onHoverNode(id),
          onMouseLeave: onHoverNode === undefined ? undefined : () => onHoverNode(null),
          onMouseMove: onHoverMove,
          onClick:
            onNodeClick === undefined
              ? undefined
              : (e) => onNodeClick(id, { toggle: extendChord(e) }),
        };

  const hovered =
    !hoverRing || hoveredId === undefined || hoveredId === null
      ? undefined
      : nodes.find(({ node }) => node.id === hoveredId);

  return (
    <>
      {/* 1 — group rectangles, outermost first */}
      <g data-layer="groups">
        {groups.map(({ group, rect }) => (
          <GroupRect key={group.id} group={group} rect={rect} />
        ))}
      </g>
      {/* 2 — group labels */}
      <g data-layer="group-labels">
        {groups.map(({ group, rect }) => (
          <GroupLabel key={group.id} group={group} rect={rect} />
        ))}
      </g>
      {/* 3 — edge paths */}
      <g data-layer="edges">
        {edges.map(({ edge, d, points }) => {
          const o = edgeOpacity(edge.id);
          const lit = edgeLit(edge.id);
          // Wrapped ONLY when it is actually dimmed. A <g> around every edge
          // in every frame would change markup the render tests and every
          // previously exported SVG can see, for the benefit of the frames
          // that have no emphasis — which is nearly all of them.
          return o === undefined ? (
            <EdgePath key={edge.id} edge={edge} d={d} points={points} lit={lit} />
          ) : (
            <g key={edge.id} opacity={o}>
              <EdgePath edge={edge} d={d} points={points} />
            </g>
          );
        })}
      </g>
      {/* 4 — edge labels, each with a halo */}
      <g data-layer="edge-labels">
        {edges.map(({ edge, label }) => {
          if (label === undefined) return null;
          const o = edgeOpacity(edge.id);
          return o === undefined ? (
            <EdgeLabel key={edge.id} edge={edge} label={label} />
          ) : (
            <g key={edge.id} opacity={o}>
              <EdgeLabel edge={edge} label={label} />
            </g>
          );
        })}
      </g>
      {/* 5 — node boxes (an entity WITH fields is drawn as a table) */}
      <g data-layer="nodes">
        {nodes.map(({ node, rect }) => {
          const Box = isEntityTable(node) ? EntityBox : NodeBox;
          const o = nodeOpacity(node.id);
          return o === undefined ? (
            <Box key={node.id} node={node} rect={rect} {...hoverOf(node.id)} />
          ) : (
            <g key={node.id} opacity={o}>
              <Box node={node} rect={rect} {...hoverOf(node.id)} />
            </g>
          );
        })}
      </g>
      {/* 6 — node icons and labels (entity: header + field rows) */}
      <g data-layer="node-content">
        {nodes.map(({ node, rect }) => {
          const Content = isEntityTable(node) ? EntityContent : NodeContent;
          const o = nodeOpacity(node.id);
          return o === undefined ? (
            <Content key={node.id} node={node} rect={rect} {...hoverOf(node.id)} />
          ) : (
            <g key={node.id} opacity={o}>
              <Content node={node} rect={rect} {...hoverOf(node.id)} />
            </g>
          );
        })}
      </g>
      {/* 7 — hover layer (capability B), above everything, never hit-tested */}
      {hovered === undefined && hoverOverlay === undefined ? null : (
        <g data-layer="hover" pointerEvents="none">
          {hovered === undefined ? null : (
            <rect
              data-hover-ring={hovered.node.id}
              x={hovered.rect.x - HOVER_RING_PAD}
              y={hovered.rect.y - HOVER_RING_PAD}
              width={hovered.rect.width + HOVER_RING_PAD * 2}
              height={hovered.rect.height + HOVER_RING_PAD * 2}
              rx={theme.node.radius + HOVER_RING_PAD}
              ry={theme.node.radius + HOVER_RING_PAD}
              fill="none"
              stroke={theme.accent[hovered.node.type]}
              strokeWidth={HOVER_RING_W}
              opacity={0.55}
            />
          )}
          {hoverOverlay}
        </g>
      )}
    </>
  );
}

// useLayoutEffect keeps the outgoing frame on screen in the SAME paint as
// the incoming one (a true cross-fade); on the server there is no layout
// pass, so fall back to useEffect to avoid React's SSR warning.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The product canvas. Renders one frame, and cross-fades over
 * CROSSFADE_MS when a NEW layout arrives: the outgoing frame stays put at
 * full opacity underneath while the incoming frame fades in on top
 * (§8.3 — cross-fade the SVG, never interpolate node positions).
 */
export function Canvas({
  doc,
  laidOut,
  paths,
  transform,
  ...hover
}: CanvasProps): JSX.Element {
  const [outgoing, setOutgoing] = useState<Frame | null>(null);
  const shown = useRef<Frame | null>(null);
  const generation = useRef(0);
  const lastLaidOut = useRef<LaidOut | null>(null);

  if (lastLaidOut.current !== laidOut) {
    lastLaidOut.current = laidOut;
    generation.current += 1;
  }

  useIsomorphicLayoutEffect(() => {
    const previous = shown.current;
    shown.current = { doc, laidOut, paths };
    if (previous === null || previous.laidOut === laidOut) return;
    setOutgoing(previous);
    const timer = setTimeout(() => setOutgoing(null), CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [doc, laidOut, paths]);

  return (
    <g data-canvas="true" transform={transform}>
      <defs>
        <ArrowMarker />
        {/* §3.9: the open head that says something comes back */}
        <ReturnMarker />
        {/* ERD: the crow's-foot pair, defined once alongside §6.7's arrow */}
        <CrowOneMarker />
        <CrowManyMarker />
        <style>{`@keyframes ${FADE_ANIM}{from{opacity:0}to{opacity:1}}`}</style>
      </defs>
      {outgoing === null ? null : (
        <g data-frame="outgoing" aria-hidden="true">
          <FrameLayers {...outgoing} />
        </g>
      )}
      <g
        key={generation.current}
        data-frame="current"
        style={{ animation: `${FADE_ANIM} ${CROSSFADE_MS}ms ease-out` }}
      >
        <FrameLayers doc={doc} laidOut={laidOut} paths={paths} {...hover} />
      </g>
    </g>
  );
}
