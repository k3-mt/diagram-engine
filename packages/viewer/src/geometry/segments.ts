// Geometry step 1 (spec §6.1): split each flattened edge polyline into
// oriented segments. Pure function — no DOM, safe to run under Node/vitest.

/** An absolute point in the flattened (root-relative) coordinate space. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A flattened edge as produced by layout/fromElk (spec §5.3): every point is
 * absolute. Geometry is derived per frame and NEVER persisted to the document
 * (spec §1.4/§3.1).
 */
export interface AbsEdge {
  id: string;
  points: Point[];
}

/** One straight piece of an edge polyline. */
export interface Seg {
  edgeId: string;
  index: number;
  orient: 'h' | 'v';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /**
   * True when the segment is a genuine diagonal (both axes move by >= 0.5px).
   * ELK's ORTHOGONAL routing shouldn't emit these, but if one appears we flag
   * it and pass it through untouched — hop detection skips it, the renderer
   * draws it as a plain line, nothing crashes.
   */
  diagonal?: boolean;
}

/**
 * Convert an edge polyline into oriented segments.
 *
 * Orientation follows the 0.5px rule (spec §6.1): ELK occasionally emits
 * sub-pixel drift, so a segment whose |dy| < 0.5 is horizontal, everything
 * else is vertical. A true diagonal (|dx| and |dy| both >= 0.5) keeps the
 * rule's orientation but is flagged `diagonal` so downstream stages ignore it.
 */
export function toSegments(edge: AbsEdge): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < edge.points.length - 1; i++) {
    const a = edge.points[i]!;
    const b = edge.points[i + 1]!;
    const seg: Seg = {
      edgeId: edge.id,
      index: i,
      orient: Math.abs(a.y - b.y) < 0.5 ? 'h' : 'v',
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y
    };
    if (Math.abs(a.y - b.y) >= 0.5 && Math.abs(a.x - b.x) >= 0.5) {
      seg.diagonal = true;
    }
    out.push(seg);
  }
  return out;
}
