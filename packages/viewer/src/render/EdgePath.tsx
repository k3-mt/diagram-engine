// render/EdgePath.tsx — edge paths (spec §8.1 layer 3), edge labels with
// haloes (layer 4), the arrowhead marker (§6.7), and §3.9's two additions:
// the RETURN LEG and the STEP BADGE.
//
// The `d` string is composed once per frame by composeFramePaths (§6.5 hops
// + §6.6 corner rounding) and handed in — never recomputed per edge, and
// never persisted (§1.4).
//
// WHAT §3.9 ADDS, AND WHY IT IS ALL IN HERE. An edge whose kind returns
// something draws ONE stroke with TWO DIFFERENT ARROWHEADS:
//
//   filled triangle, at the target   the call — who depends on whom
//   open chevron,    at the source   the response — what comes back
//
// That asymmetry is the whole mechanism, and it is the UML sequence-diagram
// convention: a filled head is a call, an open head is a reply. It answers
// the two questions a single grey arrow could not answer at once — "what
// depends on what", which is the direction the graph is walked in, and "what
// actually moves", which for a read runs the OTHER way.
//
// It is deliberately not two strokes. An earlier draft drew the return as a
// second line offset alongside the first, thinner and fainter so the pair
// read as one relationship; on a real diagram that second line read as a
// rendering seam rather than as an arrow, its label floated with no legible
// line under it, and it diverged from its own outbound leg at every bend. One
// full-weight stroke with two heads says the same thing and cannot be
// mistaken for an artefact.
//
// A `both` arrow keeps TWO FILLED heads and so stays visually distinct: two
// filled heads is a genuinely symmetric peer relationship, filled-plus-open
// is a request and its answer.
//
// An edge with none of §3.9's fields emits exactly the markup it emitted
// before §3.9.

import type { Cardinality, GEdge } from '@diagram-engine/core';
// Runtime import of the core SOURCE module, not the barrel (node:fs) — the
// same route HoverCard.tsx and NodeBox.tsx take.
import { edgeHasReturn, edgeIsAsync } from '../../../core/src/schema/graph.js';
import type { AbsEdgeLabel, AbsPoint } from '../layout/fromElk.js';
import { EDGE_LABEL_FONT, measureText } from '../layout/measure.js';
import { pointAtFraction, pointNearStart } from '../geometry/polyline.js';
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

/** id of the open return-head marker (§3.9), defined once in the <defs>. */
export const RETURN_MARKER_ID = 'return-head';

/**
 * The RETURN head (§3.9): an open chevron, drawn in stroke rather than fill.
 *
 * Open, not filled, and that is the entire distinction it carries. Put at the
 * START of a path with `orient="auto-start-reverse"` it faces back down the
 * line at the caller, so an edge reads "this end called, and this is what came
 * back". A second FILLED head there would say something else — that the two
 * ends call each other, which is what `arrow: "both"` is for.
 *
 * A touch wider than the arrowhead (9 vs 7) because an outline shape reads
 * smaller than a solid one of the same size.
 */
export function ReturnMarker(): JSX.Element {
  return (
    <marker
      id={RETURN_MARKER_ID}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="9"
      markerHeight="9"
      orient="auto-start-reverse"
    >
      <path
        d="M 2.5 1 L 9 5 L 2.5 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

// --- §3.9 decorations ------------------------------------------------------

/** Font of the small label naming what comes back. */
export const RETURN_LABEL_FONT = '400 9px system-ui, sans-serif';

/**
 * Where the return label sits: near the SOURCE end, because that is where the
 * response lands and where its own arrowhead is.
 *
 * Capped at a fraction of the route so a short edge pulls it back rather than
 * sliding it past the middle, where ELK has parked the edge's own label. Two
 * labels at one point is not a near miss: edge labels are §8.1 layer 4 and
 * carry a canvas-coloured halo, so they are painted over anything in layer 3
 * and the return label loses silently.
 */
export const RETURN_LABEL_ANCHOR = 60;
export const RETURN_LABEL_MAX_FRACTION = 0.32;
/** How far off the line the return label sits, px. */
export const RETURN_LABEL_OFFSET = 13;

/** Radius of the numbered step badge, px. */
export const SEQ_R = 8;

/**
 * How far along the edge from its source the step badge is anchored, px —
 * and why there are two of them.
 *
 * SVG markers scale with stroke width by default, so the return head on a LIT
 * edge (LIT_W, 2.5) is over half as long again as on a plain one, and a badge
 * placed to clear the plain head is swallowed by the lit one the moment the
 * reader clicks the node. So an edge that HAS a head at its source puts its
 * badge further out — sized for the lit case, since that is the one where the
 * two are both being looked at.
 */
export const SEQ_ANCHOR = 22;
export const SEQ_ANCHOR_WITH_RETURN = 38;
export const SEQ_MAX_FRACTION = 0.25;
/** Font of the number inside the badge. */
export const SEQ_FONT = '600 9px system-ui, sans-serif';

/** Stroke width of an edge drawn LIT by the selection lens (§8.7). */
export const LIT_W = 2.5;

export interface EdgePathProps {
  edge: GEdge;
  /** Composed path, from composeFramePaths. */
  d: string;
  /**
   * The edge's absolute polyline, from the layout. Optional: without it an
   * edge draws as it always did, with no step badge and no return label —
   * which is what keeps every caller that predates §3.9 working unchanged.
   * The arrowheads need no polyline, so a return HEAD is drawn either way.
   */
  points?: readonly AbsPoint[];
  /**
   * Draw this edge LIT, in this colour (§8.7's selection lens).
   *
   * The emphasis is applied HERE, to the edge itself, rather than by painting
   * a second heavy stroke over the top in the overlay layer. That was the
   * first attempt and it was wrong: layer 7 is above the edge labels and above
   * this edge's own step badge, so the stroke meant to draw attention to a
   * connection was drawn straight THROUGH the number and the words on it. An
   * edge that lights itself keeps §8.1's z-order for free — the label and the
   * badge are emitted after the path and paint over it, as they always do.
   */
  lit?: string;
}

/**
 * The dash an edge's OUTBOUND leg draws with.
 *
 * `style` still wins where an author set it, because it always did. A `kind`
 * answers for the edges that carry one instead (V20 forbids both), which is
 * rule 6 — dashed for asynchronous — applied once by the vocabulary rather
 * than restated by hand on every queue edge.
 */
export function edgeDash(edge: GEdge): string | undefined {
  return edgeIsAsync(edge) ? EDGE_DASH : undefined;
}

/**
 * Layer 3: one edge path, with arrowheads per `edge.arrow` (default
 * forward) — or, when the edge carries a cardinality, with crow's-foot
 * markers INSTEAD of the arrowheads.
 *
 * Since §3.9 this may emit a GROUP of up to four elements rather than a bare
 * <path>: the outbound leg, the return leg, the return leg's label, and the
 * step badge. An edge with none of §3.9's fields still emits the bare <path>
 * it always did — byte-identical, which is what keeps the existing render
 * tests and every previously exported SVG honest.
 */
export function EdgePath({ edge, d, points, lit }: EdgePathProps): JSX.Element {
  const arrow = edge.arrow ?? 'forward';
  const crow =
    edge.cardinality === undefined
      ? undefined
      : cardinalityMarkers(edge.cardinality);

  // A crow's-foot edge is an ERD relationship, not a directed call: it has no
  // caller, so it has no return. A `both` arrow already puts a FILLED head
  // where the return's would go, and means something different (a symmetric
  // peer, not a request and its answer) — V20 rejects that combination
  // outright, and this is the renderer declining to draw a contradiction even
  // when handed one.
  const returns =
    crow === undefined && arrow !== 'both' && arrow !== 'none' && edgeHasReturn(edge);

  const startId = crow
    ? crow.start
    : arrow === 'both'
      ? ARROW_MARKER_ID
      : returns
        ? RETURN_MARKER_ID
        : undefined;
  const endId = crow
    ? crow.end
    : arrow === 'forward' || arrow === 'both'
      ? ARROW_MARKER_ID
      : undefined;

  // The markers paint with currentColor, so `color` is what gives the
  // arrowhead / return head / crow's foot the same colour as the line — and
  // is what carries the lit colour onto them when the edge is emphasised.
  const stroke = lit ?? theme.edge.stroke;

  const path = (
    <path
      data-edge={edge.id}
      data-layer="edge-path"
      data-cardinality={edge.cardinality}
      data-kind={edge.kind}
      data-lit={lit === undefined ? undefined : 'true'}
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={lit === undefined ? theme.edge.width : LIT_W}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={edgeDash(edge)}
      markerStart={startId === undefined ? undefined : `url(#${startId})`}
      markerEnd={endId === undefined ? undefined : `url(#${endId})`}
      style={{ color: stroke }}
    />
  );

  const seq = edge.seq;
  const wantsLabel = returns && edge.returns !== undefined && points !== undefined;
  if (!wantsLabel && (seq === undefined || points === undefined)) return path;

  const labelAt = wantsLabel
    ? pointNearStart(
        points as readonly AbsPoint[],
        RETURN_LABEL_ANCHOR,
        RETURN_LABEL_MAX_FRACTION,
      )
    : null;
  const seqAt =
    seq === undefined || points === undefined
      ? null
      : pointNearStart(
          points,
          returns ? SEQ_ANCHOR_WITH_RETURN : SEQ_ANCHOR,
          SEQ_MAX_FRACTION,
        );

  return (
    <g data-edge-group={edge.id}>
      {path}
      {labelAt === null ? null : <ReturnLabel edge={edge} at={labelAt} />}
      {seqAt === null || seq === undefined ? null : (
        <SeqBadge edge={edge} seq={seq} at={seqAt} />
      )}
    </g>
  );
}

/**
 * The small label naming what comes back, sitting just off the line beside
 * the return head, with a halo behind it — the same halo trick EdgeLabel
 * uses, and for the same reason: without it the text is unreadable wherever
 * it meets a line.
 *
 * Beside the head rather than centred on the edge, because the head is what
 * it explains: the reader sees an open arrow pointing back into this box and
 * the words naming what arrives, together, at the end where it arrives.
 */
function ReturnLabel({
  edge,
  at,
}: {
  edge: GEdge;
  at: { x: number; y: number; dx: number; dy: number };
}): JSX.Element {
  const text = edge.returns as string;
  const w = measureText(text, RETURN_LABEL_FONT);
  const h = 11;
  // Offset perpendicular to travel — (dy, -dx) — so the text sits clear of
  // the stroke rather than on it, and on a consistent side whichever way the
  // edge runs. The step badge sits ON the line a little further back, so the
  // two never collide even on a short edge.
  const cx = at.x + at.dy * RETURN_LABEL_OFFSET;
  const cy = at.y - at.dx * RETURN_LABEL_OFFSET;
  return (
    <g data-edge-returns={edge.id} data-layer="edge-return-label">
      <rect
        x={cx - w / 2 - HALO_PAD_X}
        y={cy - h / 2 - HALO_PAD_Y}
        width={w + HALO_PAD_X * 2}
        height={h + HALO_PAD_Y * 2}
        rx={3}
        ry={3}
        fill={theme.canvas}
      />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fill={theme.text.secondary}
        opacity={0.9}
        style={{ font: RETURN_LABEL_FONT }}
      >
        {text}
      </text>
    </g>
  );
}

/**
 * The numbered step badge: a filled disc on the line, near the SOURCE end.
 *
 * Near the source, not at the midpoint, for two reasons. A reader following a
 * flow looks at the box a step leaves FROM, so that is where the number for
 * that step should be; and the midpoint is already spoken for by the edge
 * label, which would collide with it on every labelled edge.
 *
 * Ink-on-canvas rather than a colour: the number is an ordering, not a
 * category, and §8.2's accents mean node TYPE. A hue here would read as one.
 */
function SeqBadge({
  edge,
  seq,
  at,
}: {
  edge: GEdge;
  seq: number;
  at: { x: number; y: number };
}): JSX.Element {
  return (
    <g data-edge-seq={edge.id} data-seq={seq} data-layer="edge-seq">
      <circle
        cx={at.x}
        cy={at.y}
        r={SEQ_R}
        fill={theme.canvas}
        stroke={theme.text.primary}
        strokeWidth={1}
      />
      <text
        x={at.x}
        y={at.y}
        textAnchor="middle"
        dominantBaseline="central"
        fill={theme.text.primary}
        style={{ font: SEQ_FONT }}
      >
        {seq}
      </text>
    </g>
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
