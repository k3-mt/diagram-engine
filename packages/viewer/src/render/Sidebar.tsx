// render/Sidebar.tsx — the left panel: everything that changes WHICH ELEMENTS
// are drawn, in one place, split by the question it answers.
//
//   Grain       how much detail       a container LEVEL, uniformly
//   Containers  which boundary        go to one, or shut one
//
// That split is the whole design. The status strip along the bottom answers a
// different question — what STATE the session is in (title, counts drawn,
// connection, last update, save) — and the two must not be mixed: a reader
// hunting for "show me less" should never have to scan past a connection dot,
// and a reader checking whether the socket died should not have to parse a
// tree of container names.
//
// The [exec] [eng] [focus] presets live in the STRIP ONLY. They were briefly
// duplicated here as well; once the panel could set a level and jump to a
// named container, a second copy of three preset buttons was one more thing to
// read for something the strip already offered, and "focus" in particular
// competes with the container list — it isolates a boundary by shutting every
// other, where the list opens a path and leaves the rest alone.
//
// Everything here is a VIEWPORT control in the §7 sense: it sets the local
// override in view/viewState.ts, writes nothing, sends nothing back over the
// socket, and is still overruled the moment the agent changes doc.collapsed.
// The panel says so at the foot, because a control that can be silently
// overruled has to admit it.

import type { CSSProperties, ReactNode } from 'react';
import type { ContainerRow, DepthOption } from '../view/viewState.js';
import { ContainerTree } from './ContainerTree.js';
import { GrainControl } from './GrainControl.js';
import { theme } from './theme.js';

/** Width of the panel when open, px. The canvas sizes itself against this. */
export const SIDEBAR_WIDTH = 248;

export interface SidebarProps {
  /** Levels of grain, coarsest first. */
  depths: DepthOption[];
  /** The level the picture is at, or null when it is not a uniform level. */
  activeDepth: number | null;
  onSelectDepth: (depth: number) => void;
  /** One row per container. */
  containers: ContainerRow[];
  /** Collapse or expand one container. */
  onToggleContainer: (id: string) => void;
  /** Go to a container: open it and every boundary hiding it. */
  onRevealContainer: (id: string) => void;
  /** Add or remove a container from the "show only these" selection. */
  onSelectContainer: (id: string) => void;
  /** How many containers are picked out; 0 means no selection is active. */
  selectedCount: number;
  /** Drop the selection and open everything. */
  onClearSelection: () => void;
  /** True while the picture follows doc.collapsed rather than a local choice. */
  followingDocument: boolean;
  onClose: () => void;
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: SIDEBAR_WIDTH,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  padding: '10px 10px 8px',
  overflowY: 'auto',
  background: theme.canvas,
  borderRight: `1px solid ${theme.node.stroke}`,
  color: theme.text.primary,
  font: '12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  userSelect: 'none',
};

const headingStyle: CSSProperties = {
  margin: '0 0 6px',
  font: 'inherit',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: theme.text.secondary,
};

const sectionStyle: CSSProperties = {
  padding: '10px 0',
  borderBottom: `1px solid ${theme.node.stroke}`,
};

/** One titled section, with the sentence saying what the control is for. */
function Section(props: {
  title: string;
  hint: string;
  testId: string;
  children: ReactNode;
  last?: boolean;
}): JSX.Element {
  const { title, hint, testId, children, last = false } = props;
  return (
    <section
      data-testid={testId}
      aria-label={title}
      style={last ? { ...sectionStyle, borderBottom: 'none' } : sectionStyle}
    >
      <h2 style={headingStyle}>{title}</h2>
      <p style={{ margin: '0 0 8px', color: theme.text.secondary }}>{hint}</p>
      {children}
    </section>
  );
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const {
    depths,
    activeDepth,
    onSelectDepth,
    containers,
    onToggleContainer,
    onRevealContainer,
    onSelectContainer,
    selectedCount,
    onClearSelection,
    followingDocument,
    onClose,
  } = props;

  return (
    <aside style={panelStyle} aria-label="view controls" data-testid="sidebar">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 12 }}>View</strong>
        <button
          type="button"
          onClick={onClose}
          data-testid="sidebar-close"
          title="Hide this panel"
          aria-label="Hide view controls"
          style={{
            font: 'inherit',
            lineHeight: 1,
            padding: '3px 7px',
            borderRadius: 4,
            cursor: 'pointer',
            background: 'transparent',
            border: `1px solid ${theme.node.stroke}`,
            color: theme.text.secondary,
          }}
        >
          ⟨
        </button>
      </div>

      <Section
        testId="sidebar-grain"
        title="Grain"
        hint="How deep to draw containers before collapsing them."
      >
        <GrainControl options={depths} active={activeDepth} onSelect={onSelectDepth} />
      </Section>

      <Section
        testId="sidebar-containers"
        title="Containers"
        hint={
          selectedCount > 0
            ? 'Showing only the ticked containers. Hover a row to see what its state means.'
            : 'Tick to show only those. Click a name to go there; the chevron shuts just that one. Faded rows are not on the diagram — hover to see what is hiding them.'
        }
        last
      >
        {selectedCount === 0 ? null : (
          <p
            data-testid="selection-summary"
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 8,
              margin: '0 0 8px',
              color: theme.text.secondary,
            }}
          >
            <span>
              {selectedCount} shown, the rest collapsed
            </span>
            <button
              type="button"
              data-testid="selection-clear"
              onClick={onClearSelection}
              title="Clear the selection and open everything"
              style={{
                font: 'inherit',
                lineHeight: 1,
                padding: '2px 6px',
                borderRadius: 4,
                cursor: 'pointer',
                background: 'transparent',
                border: `1px solid ${theme.node.stroke}`,
                color: theme.text.secondary,
              }}
            >
              show all
            </button>
          </p>
        )}
        <ContainerTree
          rows={containers}
          onToggle={onToggleContainer}
          onReveal={onRevealContainer}
          onSelect={onSelectContainer}
        />
      </Section>

      <p
        data-testid="sidebar-source"
        style={{
          margin: '8px 0 0',
          paddingTop: 8,
          borderTop: `1px solid ${theme.node.stroke}`,
          color: theme.text.secondary,
        }}
      >
        {followingDocument
          ? 'Following the document. Nothing here is saved.'
          : 'Local to this tab — the next diagram view from the agent takes over.'}
      </p>
    </aside>
  );
}
