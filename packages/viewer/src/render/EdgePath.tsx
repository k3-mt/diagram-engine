// render/EdgePath.tsx — edge paths (spec §8.1 layer 3), edge labels with
// haloes (layer 4), and the arrowhead marker (§6.7).
//
// The `d` string is composed once per frame by composeFramePaths (§6.5 hops
// + §6.6 corner rounding) and handed in — never recomputed per edge, and
// never persisted (§1.4).

import type { Cardinality, GEdge } from '@diagram-engine/core';
import type { AbsEdgeLabel } from '../layout/fromElk.js';
import { EDGE_LABEL_FONT } from '../layout/measure.js';
import { theme } from './theme.js';

/** id of the single arrowhead marker defined once in the canvas <defs>. */
export const ARROW_MARKER_ID = 'arrow';

/**
 * The arrowhead marker, spec §6.7 verbatim. Because hops are guarded away
 * from endpoints the final segment is always straight, so the marker
 * orients correctly with no manual angle math. `orient="auto-start-reverse"`
 * lets ONE marker serve both ends of a `both`-arrow edge.
 */
export function ArrowMarker(): JSX.Element {
  return (
    <marker
      id={ARROW_MARKER_ID}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
    </marker>
  );
}

// ---------------------------------------------------------------------------
// Crow's-foot markers (ERD mode, spec Part 13 item 2).
//
// An ERD relationship is not a directed call, so when an edge carries a
// cardinality the crow's-foot pair REPLACES the arrowhead entirely; edges
// without one keep §6.7 exactly as it was.
//
// Orientation: both markers are drawn with the ENTITY at the +x side of
// the local marker frame. `orient="auto-start-reverse"` makes the frame at
// the START of the path point backwards along it, so the same geometry
// faces outward at both ends and one definition serves both.

/** ids of the two crow's-foot markers defined once in the canvas <defs>. */
export const ONE_MARKER_ID = 'crow-one';
export const MANY_MARKER_ID = 'crow-many';

/** "exactly one": a single bar perpendicular to the line. */
export function CrowOneMarker(): JSX.Element {
  return (
    <marker
      id={ONE_MARKER_ID}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="9"
      markerHeight="9"
      orient="auto-start-reverse"
    >
      <path
        d="M 5 1 L 5 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </marker>
  );
}

/** "many": the three-pronged crow's foot, prongs opening onto the entity. */
export function CrowManyMarker(): JSX.Element {
  return (
    <marker
      id={MANY_MARKER_ID}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="9"
      markerHeight="9"
      orient="auto-start-reverse"
    >
      <path
        d="M 9 1 L 1 5 L 9 9 M 1 5 L 9 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </marker>
  );
}

/**
 * The marker ids a cardinality puts at (start, end) — start = the `from`
 * side, end = the `to` side:
 *   1:1 → one  / one     1:N → one  / many
 *   N:1 → many / one     N:M → many / many
 */
export function cardinalityMarkers(
  cardinality: Cardinality,
): { start: string; end: string } {
  const [from, to] = cardinality.split(':');
  const marker = (side: string | undefined): string =>
    side === '1' ? ONE_MARKER_ID : MANY_MARKER_ID;
  return { start: marker(from), end: marker(to) };
}

/** Dash pattern for `style: 'dashed'` edges. */
export const EDGE_DASH = '6 4';

/** Padding around edge-label text for the halo rect. */
const HALO_PAD_X = 3;
const HALO_PAD_Y = 1;

export interface EdgePathProps {
  edge: GEdge;
  /** Composed path, from composeFramePaths. */
  d: string;
}

/**
 * Layer 3: one edge path, with arrowheads per `edge.arrow` (default
 * forward) — or, when the edge carries a cardinality, with crow's-foot
 * markers INSTEAD of the arrowheads.
 */
export function EdgePath({ edge, d }: EdgePathProps): JSX.Element {
  const arrow = edge.arrow ?? 'forward';
  const crow =
    edge.cardinality === undefined
      ? undefined
      : cardinalityMarkers(edge.cardinality);
  const startId = crow ? crow.start : arrow === 'both' ? ARROW_MARKER_ID : undefined;
  const endId = crow
    ? crow.end
    : arrow === 'forward' || arrow === 'both'
      ? ARROW_MARKER_ID
      : undefined;
  return (
    <path
      data-edge={edge.id}
      data-layer="edge-path"
      data-cardinality={edge.cardinality}
      d={d}
      fill="none"
      stroke={theme.edge.stroke}
      strokeWidth={theme.edge.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={edge.style === 'dashed' ? EDGE_DASH : undefined}
      markerStart={startId === undefined ? undefined : `url(#${startId})`}
      markerEnd={endId === undefined ? undefined : `url(#${endId})`}
      // The markers paint with currentColor, so `color` is what gives the
      // arrowhead / crow's foot the same colour as the line.
      style={{ color: theme.edge.stroke }}
    />
  );
}

export interface EdgeLabelProps {
  edge: GEdge;
  /** ELK-provided label box, already flattened to absolute coordinates. */
  label: AbsEdgeLabel;
}

/**
 * Layer 4: an edge label at the position ELK gave it, with a halo rect in
 * the canvas colour behind it — without the halo it is unreadable where it
 * sits on the line (§8.1).
 */
export function EdgeLabel({ edge, label }: EdgeLabelProps): JSX.Element {
  return (
    <g data-edge-label={edge.id} data-layer="edge-label">
      <rect
        x={label.x - HALO_PAD_X}
        y={label.y - HALO_PAD_Y}
        width={label.width + HALO_PAD_X * 2}
        height={label.height + HALO_PAD_Y * 2}
        rx={3}
        ry={3}
        fill={theme.canvas}
      />
      <text
        x={label.x + label.width / 2}
        y={label.y + label.height / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={theme.text.secondary}
        style={{ font: EDGE_LABEL_FONT }}
      >
        {label.text}
      </text>
    </g>
  );
}
