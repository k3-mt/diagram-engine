// render/GrainControl.tsx — the sidebar's "level of grain" control.
//
// One row per container level, coarsest at the top, plus an "everything open"
// end. Pressing a level collapses exactly the groups AT that level, which is
// the same rule `diagram view --depth N` stores on the document — so what a
// reader flicks through here is what the agent can make permanent, and the
// two cannot mean different things.
//
// The count beside each level ("4 containers") is the point of the control:
// it says what the press will do before it is pressed, on a diagram where
// levels are otherwise invisible until you try one.
//
// A level is a RADIO choice, not a toggle: exactly one can describe the
// picture, and when none does (someone opened a single container by hand)
// none is lit, which is the honest state rather than a nearest match.

import type { CSSProperties } from 'react';
import type { DepthOption } from '../view/viewState.js';
import { theme } from './theme.js';

export interface GrainControlProps {
  options: DepthOption[];
  /** The level the picture is at, or null when it is not a level at all. */
  active: number | null;
  onSelect: (depth: number) => void;
}

/** How a level reads in the list. Level 0 is the outermost boundary. */
export function depthLabel(depth: number): string {
  if (depth === 0) return 'Level 0 — outermost';
  return `Level ${depth}`;
}

/** "4 containers" / "1 container" / "nothing to collapse". */
export function depthCountText(count: number): string {
  if (count === 0) return 'nothing to collapse';
  return `${count} container${count === 1 ? '' : 's'}`;
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  font: 'inherit',
  textAlign: 'left',
  padding: '5px 8px',
  borderRadius: 4,
  cursor: 'pointer',
  background: 'transparent',
  border: `1px solid transparent`,
  color: theme.text.primary,
};

const activeRowStyle: CSSProperties = {
  background: theme.text.primary,
  borderColor: theme.text.primary,
  color: theme.canvas,
  fontWeight: 600,
};

export function GrainControl(props: GrainControlProps): JSX.Element {
  const { options, active, onSelect } = props;
  if (options.length === 0) {
    return (
      <p
        data-testid="grain-empty"
        style={{ margin: 0, color: theme.text.secondary, font: 'inherit' }}
      >
        This diagram has no containers, so there is only one level of grain.
      </p>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="level of grain"
      data-testid="grain-control"
      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      {options.map((option) => {
        const isActive = active === option.depth;
        return (
          <button
            key={option.depth}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-testid={`grain-level-${option.depth}`}
            data-active={isActive ? 'true' : undefined}
            title={`Collapse every container ${option.depth} level${option.depth === 1 ? '' : 's'} in`}
            onClick={() => onSelect(option.depth)}
            style={{ ...rowStyle, ...(isActive ? activeRowStyle : {}) }}
          >
            <span>{depthLabel(option.depth)}</span>
            <span style={{ opacity: 0.7, fontSize: 11 }}>
              {depthCountText(option.count)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
