// render/AnalysisOverlay.tsx — the two analysis overlays as SVG
// (spec §15.5, §18.7), drawn from the id lists view/overlayPlan.ts produced.
//
// Both are rendered into Canvas's existing `hoverOverlay` slot, which is layer
// 7: above the six §8.1 layers and never hit-tested. Nothing in Canvas.tsx,
// NodeBox.tsx or EdgePath.tsx changes, so the plain diagram is byte-for-byte
// what it was with the overlay off. Geometry is read from the frame and never
// persisted (§1.4).
//
// -------------------------------------------------------------------------
// COLOUR, AND THE NO-CARNIVAL RULE (§8.2)
// -------------------------------------------------------------------------
// §8.2's whole point is that type colour is a 3px left border and never a
// fill, because at 30 nodes a filled palette is a fairground. An analysis
// overlay is the easiest place in the product to break that: rank everything,
// colour everything, and the picture stops saying anything.
//
// So the two modes get ONE hue each, and they do not share a vocabulary:
//
//   * ANALYSIS is mostly HUELESS. Fan-in weight is carried by stroke WIDTH in
//     ink at low opacity — a quantity drawn as a quantity, with no colour
//     spent on it at all. The single accent is reserved for the two findings
//     that are qualitative: the chokepoint rings, and the longest synchronous
//     chain. Typically three or four elements out of forty.
//
//   * BLAST RADIUS spends its one accent on RISK — the ringed target and the
//     tinted at-risk set — and draws CONTAINMENT in ink instead of reaching
//     for a second, reassuring hue. That is deliberate: containment is an
//     annotation on the design's own claim, not a competing colour channel,
//     and a green "safe" set beside a red "at risk" set would read as a
//     verdict the document cannot support (C3).
//
// ANALYSIS_ACCENT is a muted crimson chosen from outside the seven §8.2 type
// accents, so a ring can never be mistaken for a node's type border.
//
// -------------------------------------------------------------------------
// WHY THE EDGE STROKES ARE MASKED
// -------------------------------------------------------------------------
// §8.1 puts nodes above edges so an edge clipping a box corner is hidden
// rather than drawn across it. Layer 7 sits above the boxes, so a thick
// overlay stroke would undo that rule for exactly the edges the overlay is
// emphasising. The edge strokes are therefore drawn through a mask that
// punches out the drawn NODE rects — groups are containers, not obstacles,
// the same distinction geometry/ makes when guarding hops. Rings, tints and
// badges are attached to boxes and are unmasked by design.

import type { ReactNode } from 'react';
import type { AbsPoint, LaidOut, Rect } from '../layout/fromElk.js';
import { measureText } from '../layout/measure.js';
import type { AnalysisPlan, BlastPlan } from '../view/overlayPlan.js';
import { theme } from './theme.js';

/** The one accent, shared by both modes. Not a §8.2 type colour (see header). */
export const ANALYSIS_ACCENT = '#A8324A';

/** The hueless channel: quantities and annotations. */
export const ANALYSIS_INK = theme.text.primary;

/** How far a ring sits outside its box, px, and how thick it is drawn. */
export const RING_PAD = 4;
export const RING_W = 2;

/** The outer halo of the blast target's bullseye. */
export const TARGET_HALO_PAD = 8;

/** Alpha of the at-risk tint. A TINT — the box must stay readable through it. */
export const AT_RISK_TINT = 0.1;

/**
 * Font of the `fan-in 9 (7 sync)` badge.
 *
 * Named OVERLAY_BADGE_FONT, not BADGE_FONT: layout/measure.ts already owns
 * that name for the 9px ERD PK/FK pill, EntityBox re-exports it, and the
 * package barrel exports it. Two different fonts under one name in one package
 * is the kind of collision that resolves itself silently at the import site.
 */
export const OVERLAY_BADGE_FONT = '600 10px system-ui, sans-serif';

/** Half-length of the firebreak bar drawn across a containing dashed edge. */
export const FIREBREAK_LEN = 7;

/** id of the mask that keeps overlay edge strokes behind the node boxes. */
export const EDGE_MASK_ID = 'de-overlay-edge-mask';

/** Slack around the frame so a stroke leaving the bounds is still unmasked. */
const MASK_MARGIN = 400;

/** Baseline width of an overlay edge stroke, and the cap it grows to. */
export const OVERLAY_EDGE_W = 2;
export const OVERLAY_EDGE_W_MAX = 7;

/**
 * Stroke width for an edge converging on a chokepoint with `weight`
 * synchronous callers. Grows with fan-in and then stops: past about seven the
 * difference between 8 and 12 callers is not what the reader needs, and an
 * unbounded ramp would swallow the boxes it points at.
 */
export function weightedEdgeWidth(weight: number): number {
  const w = OVERLAY_EDGE_W + Math.max(0, weight - 1) * 1.1;
  return Math.min(w, OVERLAY_EDGE_W_MAX);
}

/** A point on a polyline plus the unit normal there. */
export interface MidPoint {
  x: number;
  y: number;
  /** unit normal to the polyline at that point */
  nx: number;
  ny: number;
}

/**
 * The point half way along a polyline by ARC LENGTH, with the normal of the
 * segment it falls on. Arc length rather than "the middle vertex" because an
 * orthogonal route's vertices cluster near its bends, and a firebreak bar
 * drawn at a bend reads as decoration rather than as a break in the line.
 */
export function polylineMidpoint(points: readonly AbsPoint[]): MidPoint | null {
  if (points.length < 2) return null;
  const seg: { a: AbsPoint; b: AbsPoint; len: number }[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as AbsPoint;
    const b = points[i] as AbsPoint;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    total += len;
    seg.push({ a, b, len });
  }
  if (total === 0) {
    const a = points[0] as AbsPoint;
    return { x: a.x, y: a.y, nx: 0, ny: 1 };
  }
  let want = total / 2;
  for (const { a, b, len } of seg) {
    if (len === 0) continue;
    if (want > len) {
      want -= len;
      continue;
    }
    const t = want / len;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: -dy, ny: dx };
  }
  const last = seg[seg.length - 1] as { a: AbsPoint; b: AbsPoint; len: number };
  return { x: last.b.x, y: last.b.y, nx: 0, ny: 1 };
}

/** Drawn edge id -> the composed path and the polyline behind it. */
export interface EdgeIndex {
  get(id: string): { d: string; points: AbsPoint[] } | undefined;
}

/** Pair `laidOut.edges` with the frame's composed `paths`, by index. */
export function edgeIndex(laidOut: LaidOut, paths: readonly string[]): EdgeIndex {
  const map = new Map<string, { d: string; points: AbsPoint[] }>();
  laidOut.edges.forEach((e, i) => {
    const d = paths[i];
    if (d === undefined || d === '') return;
    map.set(e.id, { d, points: e.points });
  });
  return map;
}

/** Common props: the frame the overlay is drawn over. */
interface FrameProps {
  laidOut: LaidOut;
  paths: readonly string[];
  /** ids of the DRAWN document's NODES — what the edge mask punches out. */
  nodeIds: readonly string[];
}

/** The node-punching mask (see header). Rendered once per overlay. */
function EdgeMask({ laidOut, nodeIds }: Omit<FrameProps, 'paths'>): JSX.Element {
  const x = -MASK_MARGIN;
  const y = -MASK_MARGIN;
  const width = laidOut.width + MASK_MARGIN * 2;
  const height = laidOut.height + MASK_MARGIN * 2;
  return (
    <mask id={EDGE_MASK_ID} maskUnits="userSpaceOnUse" x={x} y={y} width={width} height={height}>
      <rect x={x} y={y} width={width} height={height} fill="#fff" />
      {nodeIds.map((id) => {
        const r = laidOut.nodes.get(id);
        return r === undefined ? null : (
          <rect
            key={id}
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            rx={theme.node.radius}
            ry={theme.node.radius}
            fill="#000"
          />
        );
      })}
    </mask>
  );
}

/** A rounded ring around a box, `pad` px outside it. */
function Ring(props: {
  rect: Rect;
  pad: number;
  stroke: string;
  width: number;
  opacity: number;
  dashed?: boolean;
  testId?: string;
  id: string;
}): JSX.Element {
  const { rect, pad, stroke, width, opacity, dashed = false, testId, id } = props;
  return (
    <rect
      data-overlay-ring={testId === undefined ? undefined : id}
      data-overlay={testId}
      x={rect.x - pad}
      y={rect.y - pad}
      width={rect.width + pad * 2}
      height={rect.height + pad * 2}
      rx={theme.node.radius + pad}
      ry={theme.node.radius + pad}
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeDasharray={dashed ? '4 3' : undefined}
      opacity={opacity}
    />
  );
}

/**
 * The `fan-in 9 (7 sync)` badge, hung above the top-right corner of a box,
 * with a halo in the canvas colour so it stays readable over a group fill or
 * a passing edge — the same trick the §8.1 edge labels use.
 */
function Badge({ rect, text }: { rect: Rect; text: string }): JSX.Element {
  const padX = 4;
  const w = measureText(text, OVERLAY_BADGE_FONT) + padX * 2;
  const h = 14;
  const x = rect.x + rect.width - w;
  const y = rect.y - RING_PAD - h - 2;
  return (
    <g data-overlay="badge">
      <rect x={x} y={y} width={w} height={h} rx={3} ry={3} fill={theme.canvas} />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={3}
        ry={3}
        fill={ANALYSIS_ACCENT}
        opacity={0.12}
      />
      <text
        x={x + w / 2}
        y={y + h / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={ANALYSIS_ACCENT}
        style={{ font: OVERLAY_BADGE_FONT }}
      >
        {text}
      </text>
    </g>
  );
}

export interface AnalysisOverlayProps extends FrameProps {
  plan: AnalysisPlan;
}

/**
 * §15.5: edges weighted by fan-in, chokepoints ringed, the longest
 * synchronous chain highlighted. Three findings, one accent, no heat map.
 */
export function AnalysisOverlay({
  plan,
  laidOut,
  paths,
  nodeIds,
}: AnalysisOverlayProps): JSX.Element {
  const edges = edgeIndex(laidOut, paths);
  const cycleEdges = new Set(plan.chainCycleEdges);
  return (
    <g data-overlay-mode="analysis">
      <defs>
        <EdgeMask laidOut={laidOut} nodeIds={nodeIds} />
      </defs>
      <g mask={`url(#${EDGE_MASK_ID})`}>
        {/* fan-in weight: a quantity, drawn as width in ink, no hue spent */}
        {plan.weighted.map(({ id, weight }) => {
          const e = edges.get(id);
          return e === undefined ? null : (
            <path
              key={id}
              data-overlay="weighted-edge"
              data-overlay-edge={id}
              data-weight={weight}
              d={e.d}
              fill="none"
              stroke={ANALYSIS_INK}
              strokeWidth={weightedEdgeWidth(weight)}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.22}
            />
          );
        })}
        {/* the longest synchronous chain: the accent's first job. A step that
            is a CYCLE is dashed, never drawn as a straight run of calls. */}
        {plan.chain.map((id) => {
          const e = edges.get(id);
          return e === undefined ? null : (
            <path
              key={id}
              data-overlay="chain-edge"
              data-overlay-edge={id}
              data-cycle={cycleEdges.has(id) ? 'true' : undefined}
              d={e.d}
              fill="none"
              stroke={ANALYSIS_ACCENT}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={cycleEdges.has(id) ? '5 4' : undefined}
              opacity={0.85}
            />
          );
        })}
      </g>
      {/* chokepoints: the accent's second job, plus §15.4's headline number */}
      {plan.rings.map((ring) => {
        const rect = laidOut.nodes.get(ring.id);
        return rect === undefined ? null : (
          <g key={ring.id}>
            <Ring
              id={ring.id}
              testId="chokepoint"
              rect={rect}
              pad={RING_PAD}
              stroke={ANALYSIS_ACCENT}
              width={RING_W}
              opacity={0.9}
            />
            <Badge rect={rect} text={ring.badge} />
          </g>
        );
      })}
    </g>
  );
}

export interface BlastOverlayProps extends FrameProps {
  plan: BlastPlan;
}

/**
 * §18.7: ring the target, tint what is at risk, and DRAW THE CONTAINED
 * BOUNDARY at the dashed edges.
 *
 * The containment marks are the point of the mode, not a footnote. A cascade
 * that stops is the design's own safety claim (§18.3), and an overlay that
 * showed only the red set would be showing half the prediction — the half
 * that is easier to believe. Each contained node gets a dashed ink ring and
 * each containing edge a firebreak bar across it, so the boundary is a thing
 * you can see rather than an absence you have to notice.
 */
export function BlastOverlay({
  plan,
  laidOut,
  paths,
  nodeIds,
}: BlastOverlayProps): JSX.Element {
  const edges = edgeIndex(laidOut, paths);
  const targetRect = plan.target === null ? undefined : laidOut.nodes.get(plan.target);
  return (
    <g data-overlay-mode="blast">
      <defs>
        <EdgeMask laidOut={laidOut} nodeIds={nodeIds} />
      </defs>
      {/* the cascade's own edges, behind the boxes like every other edge */}
      <g mask={`url(#${EDGE_MASK_ID})`}>
        {plan.atRiskEdges.map((id) => {
          const e = edges.get(id);
          return e === undefined ? null : (
            <path
              key={id}
              data-overlay="at-risk-edge"
              data-overlay-edge={id}
              d={e.d}
              fill="none"
              stroke={ANALYSIS_ACCENT}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.7}
            />
          );
        })}
      </g>
      {/* at risk — a TINT, never a fill: the box must stay readable (§8.2) */}
      {plan.atRisk.map((id) => {
        const rect = laidOut.nodes.get(id);
        return rect === undefined ? null : (
          <rect
            key={id}
            data-overlay="at-risk"
            data-overlay-node={id}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            rx={theme.node.radius}
            ry={theme.node.radius}
            fill={ANALYSIS_ACCENT}
            opacity={AT_RISK_TINT}
          />
        );
      })}
      {/* contained: ink, dashed — the design's claim, annotated not coloured */}
      {plan.contained.map((id) => {
        const rect = laidOut.nodes.get(id);
        return rect === undefined ? null : (
          <Ring
            key={id}
            id={id}
            testId="contained"
            rect={rect}
            pad={RING_PAD}
            stroke={ANALYSIS_INK}
            width={1.5}
            opacity={0.55}
            dashed
          />
        );
      })}
      {plan.containedEdges.map((id) => {
        const e = edges.get(id);
        const mid = e === undefined ? null : polylineMidpoint(e.points);
        return mid === null ? null : (
          <line
            key={id}
            data-overlay="firebreak"
            data-overlay-edge={id}
            x1={mid.x - mid.nx * FIREBREAK_LEN}
            y1={mid.y - mid.ny * FIREBREAK_LEN}
            x2={mid.x + mid.nx * FIREBREAK_LEN}
            y2={mid.y + mid.ny * FIREBREAK_LEN}
            stroke={ANALYSIS_INK}
            strokeWidth={2.5}
            strokeLinecap="round"
            opacity={0.8}
          />
        );
      })}
      {/* the target: a bullseye, so which experiment this is is never in doubt */}
      {targetRect === undefined || plan.target === null ? null : (
        <g>
          <Ring
            id={plan.target}
            testId="blast-target"
            rect={targetRect}
            pad={RING_PAD}
            stroke={ANALYSIS_ACCENT}
            width={2.5}
            opacity={1}
          />
          <Ring
            id={plan.target}
            rect={targetRect}
            pad={TARGET_HALO_PAD}
            stroke={ANALYSIS_ACCENT}
            width={1}
            opacity={0.35}
          />
        </g>
      )}
    </g>
  );
}

/** Pick the overlay for the current mode. Null renders nothing at all. */
export function overlayFor(
  mode: 'off' | 'analysis' | 'blast',
  analysis: AnalysisOverlayProps['plan'] | null,
  blast: BlastOverlayProps['plan'] | null,
  frame: FrameProps,
): ReactNode {
  if (mode === 'analysis' && analysis !== null) {
    return <AnalysisOverlay plan={analysis} {...frame} />;
  }
  if (mode === 'blast' && blast !== null) {
    return <BlastOverlay plan={blast} {...frame} />;
  }
  return null;
}
