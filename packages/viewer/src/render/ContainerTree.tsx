// render/ContainerTree.tsx — the sidebar's per-container list.
//
// One row per group, indented by its level. Each row carries TWO controls,
// because they are two different intentions:
//
//   the checkbox  pick it out — with a selection, ONLY the picked containers
//                 (and the boundaries above them) are open
//   the chevron   collapse or expand THIS container, nothing else
//   the name      GO TO this container — open it and everything hiding it
//
// The name is the one that matters. A row three levels down can be open and
// still not on screen, because a boundary above it is shut; clicking its name
// opens the whole chain down to it, so the list is a way of navigating the
// diagram rather than a list of switches that sometimes appear to do nothing.
// Every OTHER container keeps whatever state the reader gave it — this only
// ever opens, unlike `focus`, which isolates one boundary by shutting the rest.
//
// A row whose ancestor is collapsed is still listed and marked, because it is
// not currently drawn — but it is NOT disabled: clicking it is precisely how
// you get to it. The mark says "not on screen", never "unavailable".

import type { CSSProperties } from 'react';
import { rowHint, rowStateText, type ContainerRow } from '../view/viewState.js';
import { theme } from './theme.js';

export interface ContainerTreeProps {
  rows: ContainerRow[];
  /** Collapse or expand this one container. */
  onToggle: (id: string) => void;
  /** Open this container and every boundary hiding it. */
  onReveal: (id: string) => void;
  /** Add or remove this container from the "show only these" selection. */
  onSelect: (id: string) => void;
}

/**
 * "3 nodes · 1 container" — what is directly inside, regardless of state.
 * The chip shown on the row is rowStateText, which says "not shown" or
 * "collapsed" first and falls back to this; keep them separate so a hint can
 * name the contents of a row that is currently hidden.
 */
export function contentsText(row: ContainerRow): string {
  const parts: string[] = [];
  if (row.nodeCount > 0) {
    parts.push(`${row.nodeCount} node${row.nodeCount === 1 ? '' : 's'}`);
  }
  if (row.groupCount > 0) {
    parts.push(`${row.groupCount} container${row.groupCount === 1 ? '' : 's'}`);
  }
  return parts.length === 0 ? 'empty' : parts.join(' · ');
}

/** Indent per level, px. Small: the list is 240px wide and nests three deep. */
export const INDENT = 12;

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  font: 'inherit',
  textAlign: 'left',
  padding: '4px 6px',
  borderRadius: 4,
  cursor: 'pointer',
  background: 'transparent',
  border: '1px solid transparent',
  color: theme.text.primary,
};

export function ContainerTree(props: ContainerTreeProps): JSX.Element {
  const { rows, onToggle, onReveal, onSelect } = props;
  if (rows.length === 0) {
    return (
      <p
        data-testid="containers-empty"
        style={{ margin: 0, color: theme.text.secondary, font: 'inherit' }}
      >
        This diagram has no containers yet.
      </p>
    );
  }
  return (
    <div
      role="tree"
      aria-label="containers"
      data-testid="container-tree"
      style={{ display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      {rows.map((row) => {
        const open = !row.collapsed;
        return (
          <div
            key={row.group.id}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={open}
            data-testid={`container-row-${row.group.id}`}
            data-collapsed={row.collapsed ? 'true' : undefined}
            data-hidden-by-ancestor={row.hiddenByAncestor ? 'true' : undefined}
            data-selected={row.selected ? 'true' : undefined}
            aria-selected={row.selected}
            title={rowHint(row)}
            style={{
              ...rowStyle,
              paddingLeft: 6 + row.depth * INDENT,
              background: row.selected
                ? 'rgba(59,111,212,.12)'
                : row.collapsed
                  ? 'rgba(0,0,0,.05)'
                  : 'transparent',
              boxShadow: row.selected ? `inset 2px 0 0 ${theme.accent.service}` : undefined,
            }}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={row.selected}
              data-testid={`container-select-${row.group.id}`}
              aria-label={`Show only ${row.group.label}`}
              title={
                row.selected
                  ? 'Remove from the shown set'
                  : 'Show only this — add to the set, everything else collapses'
              }
              onClick={() => onSelect(row.group.id)}
              style={{
                font: 'inherit',
                lineHeight: 1,
                width: 14,
                height: 14,
                flex: '0 0 auto',
                padding: 0,
                borderRadius: 3,
                cursor: 'pointer',
                background: row.selected ? theme.accent.service : 'transparent',
                border: `1px solid ${row.selected ? theme.accent.service : theme.node.stroke}`,
                color: theme.canvas,
                fontSize: 10,
              }}
            >
              {row.selected ? '✓' : ''}
            </button>
            <button
              type="button"
              data-testid={`container-toggle-${row.group.id}`}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${row.group.label}`}
              title={
                row.hiddenByAncestor
                  ? `${open ? 'Collapse' : 'Expand'} this container. It will not appear until “${row.hiddenBy?.label ?? ''}” is opened.`
                  : `${open ? 'Collapse' : 'Expand'} this one container. Nothing else moves.`
              }
              onClick={() => onToggle(row.group.id)}
              style={{
                font: 'inherit',
                lineHeight: 1,
                width: 16,
                padding: 0,
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                color: theme.text.secondary,
              }}
            >
              {open ? '▾' : '▸'}
            </button>
            <button
              type="button"
              data-testid={`container-goto-${row.group.id}`}
              title={rowHint(row)}
              onClick={() => onReveal(row.group.id)}
              style={{
                flex: 1,
                font: 'inherit',
                textAlign: 'left',
                padding: 0,
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                // Dimmed because it is not on screen — never disabled, since
                // pressing it is exactly how you get there.
                color: row.hiddenByAncestor ? theme.text.secondary : theme.text.primary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.group.label}
            </button>
            <span
              data-testid={`container-state-${row.group.id}`}
              title={rowHint(row)}
              style={{ color: theme.text.secondary, fontSize: 11 }}
            >
              {rowStateText(row)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
