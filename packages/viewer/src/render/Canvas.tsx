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
import type { GEdge, GNode, GraphDoc } from '@diagram-engine/core';
import type { LaidOut, Rect } from '../layout/fromElk.js';
import { EdgeLabel, EdgePath, ArrowMarker } from './EdgePath.js';
import { GroupLabel, GroupRect } from './GroupRect.js';
import { NodeBox, NodeContent } from './NodeBox.js';

/** Cross-fade duration between successive layouts (§8.3). */
export const CROSSFADE_MS = 150;

/** Name of the injected fade keyframes. */
const FADE_ANIM = 'de-frame-fade';

export interface CanvasProps {
  doc: GraphDoc;
  laidOut: LaidOut;
  /** Composed edge paths, index-aligned with `laidOut.edges`. */
  paths: string[];
  /** Viewport transform from the parent (§8.3), e.g. "translate(x,y) scale(s)". */
  transform?: string;
}

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

/** Laid-out edges paired with their document entry and composed path. */
function placedEdges(
  doc: GraphDoc,
  laidOut: LaidOut,
  paths: string[],
): { edge: GEdge; d: string; label: LaidOut['edges'][number]['label'] }[] {
  const byId = new Map<string, GEdge>(doc.edges.map((e) => [e.id, e]));
  return laidOut.edges.flatMap((abs, i) => {
    const edge = byId.get(abs.id);
    const d = paths[i];
    if (edge === undefined || d === undefined || d === '') return [];
    return [{ edge, d, label: abs.label }];
  });
}

/** One frame's six z-ordered layers (§8.1). Pure — no state, no effects. */
export function FrameLayers({ doc, laidOut, paths }: Frame): JSX.Element {
  const groups = orderedGroups(doc, laidOut);
  const nodes = placedNodes(doc, laidOut);
  const edges = placedEdges(doc, laidOut, paths);

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
        {edges.map(({ edge, d }) => (
          <EdgePath key={edge.id} edge={edge} d={d} />
        ))}
      </g>
      {/* 4 — edge labels, each with a halo */}
      <g data-layer="edge-labels">
        {edges.map(({ edge, label }) =>
          label === undefined ? null : (
            <EdgeLabel key={edge.id} edge={edge} label={label} />
          ),
        )}
      </g>
      {/* 5 — node boxes */}
      <g data-layer="nodes">
        {nodes.map(({ node, rect }) => (
          <NodeBox key={node.id} node={node} rect={rect} />
        ))}
      </g>
      {/* 6 — node icons and labels */}
      <g data-layer="node-content">
        {nodes.map(({ node, rect }) => (
          <NodeContent key={node.id} node={node} rect={rect} />
        ))}
      </g>
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
export function Canvas({ doc, laidOut, paths, transform }: CanvasProps): JSX.Element {
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
        <FrameLayers doc={doc} laidOut={laidOut} paths={paths} />
      </g>
    </g>
  );
}
