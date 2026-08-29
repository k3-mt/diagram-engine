// render/icons.tsx — one hand-drawn 20px inline SVG glyph per NodeType
// (spec §8.2; the eighth, `entity`, is the ERD addition). Simple line
// art, stroke currentColor, no icon library. Each renders as a nested
// <svg> so the caller positions it
// with x/y inside the main canvas <svg>; the colour is inherited from
// the CSS `color` of the surrounding element (currentColor).

import type { NodeType } from '@diagram-engine/core';

/** Glyph edge length, px. */
export const ICON_SIZE = 20;

export interface IconProps {
  /** Absolute x of the glyph's top-left inside the parent SVG. */
  x?: number;
  /** Absolute y of the glyph's top-left inside the parent SVG. */
  y?: number;
}

/** Shared wrapper: 20×20 viewBox, line art in currentColor. */
function Glyph({ x, y, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      x={x ?? 0}
      y={y ?? 0}
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** service — a gear: hub circle plus eight spokes. */
export function ServiceIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <circle cx={10} cy={10} r={3.2} />
      <path d="M10 2.5v2.8M10 14.7v2.8M2.5 10h2.8M14.7 10h2.8M4.7 4.7l2 2M13.3 13.3l2 2M15.3 4.7l-2 2M6.7 13.3l-2 2" />
    </Glyph>
  );
}

/** database — a cylinder. */
export function DatabaseIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <ellipse cx={10} cy={4.8} rx={6.4} ry={2.4} />
      <path d="M3.6 4.8v10.4c0 1.3 2.9 2.4 6.4 2.4s6.4-1.1 6.4-2.4V4.8" />
      <path d="M3.6 10c0 1.3 2.9 2.4 6.4 2.4s6.4-1.1 6.4-2.4" />
    </Glyph>
  );
}

/** queue — stacked messages flowing toward an arrowhead. */
export function QueueIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M3 6h9M3 10h9M3 14h9" />
      <path d="M14.5 7.5 17 10l-2.5 2.5" />
    </Glyph>
  );
}

/** cache — a lightning bolt. */
export function CacheIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M11.5 2.5 5 11h4l-1.2 6.5L14.8 9h-4l0.7-6.5z" />
    </Glyph>
  );
}

/** storage — a bucket/box with a lid line and a handle. */
export function StorageIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <rect x={3} y={4.5} width={14} height={12} rx={1.5} />
      <path d="M3 8.5h14M8 12.5h4" />
    </Glyph>
  );
}

/** client — a monitor on a stand. */
export function ClientIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <rect x={3} y={3.5} width={14} height={9.5} rx={1.2} />
      <path d="M10 13v3M6.8 16.5h6.4" />
    </Glyph>
  );
}

/** external — a cloud (a third party you don't control). */
export function ExternalIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <path d="M6 15.5h8.3a3.2 3.2 0 0 0 .4-6.4 4.6 4.6 0 0 0-8.9 1A2.9 2.9 0 0 0 6 15.5z" />
    </Glyph>
  );
}

/**
 * collapsed group — a dashed-cornered boundary with a solid box inside it:
 * "a container whose insides are not shown here". NOT a NodeType glyph. It
 * is chosen by isCollapsedGroupNode(), never by NODE_ICONS, because a
 * collapsed VPC is drawn with `type: "external"` (derive.ts decision 1) and
 * the external glyph is a cloud, documented as "a third party you don't
 * control" — a confident wrong claim about the reader's own boundary. The
 * dash echoes GroupRect's §8.2 `4 4`, so the closed boundary reads as the
 * same object the open one does.
 */
export function CollapsedGroupIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <rect x={2.2} y={3.2} width={15.6} height={13.6} rx={2} strokeDasharray="3 2.4" />
      <rect x={6.4} y={7.4} width={7.2} height={5.2} rx={1} />
    </Glyph>
  );
}

/** entity — a table/grid: a header band over a two-column body (ERD mode). */
export function EntityIcon(props: IconProps): JSX.Element {
  return (
    <Glyph {...props}>
      <rect x={2.5} y={3.5} width={15} height={13} rx={1.5} />
      <path d="M2.5 7.5h15M2.5 12h15M8.5 7.5v9" />
    </Glyph>
  );
}

/** One glyph per NodeType (spec §8.2). */
export const NODE_ICONS: Record<NodeType, (props: IconProps) => JSX.Element> = {
  service: ServiceIcon,
  database: DatabaseIcon,
  queue: QueueIcon,
  cache: CacheIcon,
  storage: StorageIcon,
  client: ClientIcon,
  external: ExternalIcon,
  entity: EntityIcon,
};
