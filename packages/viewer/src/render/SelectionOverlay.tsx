// render/SelectionOverlay.tsx — the seventh-layer lens that LIGHTS UP one
// node's connections (spec §8.7).
//
// Click a box and three things happen at once: the box is ringed in its own
// type accent, every edge touching it is redrawn heavy, and everything else
// on the canvas is dimmed. The dimming is what does the real work — a heavy
// stroke among forty other strokes is hard to find, whereas the only dark
// line on a faded page is impossible to miss.
//
// TWO TREATMENTS, NOT ONE. The lines LEAVING the node are drawn in the node's
// own accent, the lines ARRIVING in ink. That is the distinction the reader
// came for ("what does this depend on" versus "what depends on this") and the
// arrowheads alone do not carry it at a glance across a large diagram. Using
// the selected node's accent for its outgoing edges is deliberate and is the
// one place §8.2's "accent means node type" rule is stretched: here the hue is
// tying those lines to THAT box, which is wearing the same hue on its ring and
// its left border two inches away. Only ever one node is selected, so only
// ever one accent is on screen in this role.
//
// THIS COMPONENT DRAWS ONLY RINGS. The lit edges are drawn by the EDGES
// THEMSELVES, in layer 3, from the colour map this module builds (litEdges
// below, handed to Canvas as `emphasis.edges`).
//
// That split is a correction, and the reason is worth keeping. The first
// version painted a second heavy stroke over each connection here, in layer
// 7, masked so it would not cover the node boxes. But layer 7 is also above
// the edge LABELS (layer 4) and above an edge's own step badge — neither of
// which a mask declared here can locate, because EdgePath decides where they
// go. So the stroke meant to draw attention to a connection was drawn
// straight through the number and the words written on it. Widening the mask
// would have meant this module re-deriving positions that belong to another;
// letting the edge light itself gets the z-order right by construction and
// deletes the mask altogether.
//
// Read-only and stateless, like every overlay: it draws a lens over one tab
// and never touches the document (§1.6).

import type { LaidOut, Rect } from '../layout/fromElk.js';
import type { SelectionView } from '../view/selection.js';
import { RING_PAD } from './AnalysisOverlay.js';
import { theme } from './theme.js';

/** Ring width on the selected node, and on the boxes at the far ends. */
export const SELECTED_RING_W = 2.5;
export const NEIGHBOUR_RING_W = 1.5;
/**
 * Opacity everything OUTSIDE the selection is drawn at. Low enough that the
 * lit connections are the only thing the eye lands on, high enough that the
 * rest of the diagram is still legible as context rather than erased — the
 * reader needs to see WHERE in the system the selected box sits.
 */
export const DIMMED = 0.16;

/**
 * The colour every lit edge is drawn in: outgoing in the selected node's own
 * accent, incoming in ink.
 *
 * Built here, where the vocabulary lives, and handed to Canvas as
 * `emphasis.edges` so the edges can draw themselves lit. One map means the
 * panel's direction stripes, the canvas strokes and the rings cannot drift
 * apart — they are all reading the same answer.
 *
 * An edge that is somehow both (a self-edge, which V6 forbids) resolves to
 * outgoing, matching how selectionView reports it.
 */
export function litEdges(
  selection: SelectionView,
  accent: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of selection.incoming) out.set(c.drawnId, theme.text.primary);
  for (const c of selection.outgoing) out.set(c.drawnId, accent);
  return out;
}

export interface SelectionOverlayProps {
  selection: SelectionView;
  laidOut: LaidOut;
}

/** A rounded ring around a box, `pad` px outside it. */
function Ring(props: {
  id: string;
  rect: Rect;
  stroke: string;
  width: number;
  role: string;
}): JSX.Element {
  const { id, rect, stroke, width, role } = props;
  return (
    <rect
      data-selection-ring={id}
      data-selection={role}
      x={rect.x - RING_PAD}
      y={rect.y - RING_PAD}
      width={rect.width + RING_PAD * 2}
      height={rect.height + RING_PAD * 2}
      rx={theme.node.radius + RING_PAD}
      ry={theme.node.radius + RING_PAD}
      fill="none"
      stroke={stroke}
      strokeWidth={width}
    />
  );
}

export function SelectionOverlay({
  selection,
  laidOut,
}: SelectionOverlayProps): JSX.Element {
  const accent = theme.accent[selection.node.type];
  const selfRect = laidOut.nodes.get(selection.node.id);

  return (
    <g data-layer="selection-overlay" data-selection-node={selection.node.id}>
      {/* The far ends: a thin ink ring, so the reader can see WHICH boxes the
          lit lines land on without tracing every one of them by eye. */}
      {[...selection.nodeIds]
        .filter((id) => id !== selection.node.id)
        .map((id) => {
          const rect = laidOut.nodes.get(id);
          return rect === undefined ? null : (
            <Ring
              key={id}
              id={id}
              rect={rect}
              stroke={theme.text.primary}
              width={NEIGHBOUR_RING_W}
              role="neighbour"
            />
          );
        })}

      {/* The selected box itself, last, in its own accent. */}
      {selfRect === undefined ? null : (
        <Ring
          id={selection.node.id}
          rect={selfRect}
          stroke={accent}
          width={SELECTED_RING_W}
          role="selected"
        />
      )}
    </g>
  );
}
