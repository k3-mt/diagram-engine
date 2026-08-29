// render/GroupRect.tsx — the group container and its label (spec §8.1
// layers 1 and 2, §8.2 theme).
//
// Two components, not one, because the z-order is strict: EVERY group
// rectangle is drawn (outermost first) before ANY group label, and both
// sit under the edges. Canvas.tsx emits them as two separate layers.

import type { GGroup } from '@diagram-engine/core';
import type { Rect } from '../layout/fromElk.js';
import { theme } from './theme.js';

/**
 * Top padding ELK reserves inside a group (GROUP_OPTIONS
 * 'elk.padding' top=44, left=20) — the label band. The label is drawn
 * inside it, so it never collides with the children below.
 */
export const GROUP_PAD_TOP = 44;
export const GROUP_PAD_LEFT = 20;

/** The font group labels are drawn in. */
export const GROUP_LABEL_FONT = '600 12px system-ui, sans-serif';

export interface GroupRectProps {
  group: GGroup;
  rect: Rect;
}

/** Layer 1: the dashed container rectangle. */
export function GroupRect({ group, rect }: GroupRectProps): JSX.Element {
  return (
    <rect
      data-group={group.id}
      data-layer="group-rect"
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      rx={theme.group.radius}
      ry={theme.group.radius}
      fill={theme.group.fill}
      stroke={theme.group.stroke}
      strokeDasharray={theme.group.dash}
      strokeWidth={1}
    />
  );
}

/** Layer 2: the group label, in the 44px top padding band. */
export function GroupLabel({ group, rect }: GroupRectProps): JSX.Element {
  return (
    <text
      data-group-label={group.id}
      data-layer="group-label"
      x={rect.x + GROUP_PAD_LEFT}
      y={rect.y + GROUP_PAD_TOP / 2}
      dominantBaseline="central"
      textAnchor="start"
      fill={theme.text.secondary}
      style={{ font: GROUP_LABEL_FONT, letterSpacing: '0.02em' }}
    >
      {group.label}
    </text>
  );
}
