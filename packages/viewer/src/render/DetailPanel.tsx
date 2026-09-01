// render/DetailPanel.tsx — the RIGHT panel: everything the document holds
// about ONE node, opened by clicking it (spec §8.7).
//
// The division of labour with the hover card (HoverCard.tsx) is the whole
// design, and neither panel is redundant:
//
//   HOVER  a glance. Follows the pointer, vanishes when it leaves, never
//          takes a click. Answers "what is this box" while the reader's
//          attention is still on the diagram.
//   CLICK  a stop. Pinned to the right edge, stays until dismissed, takes
//          clicks. Answers "tell me everything about this box, including
//          what it is wired to" — and the connections are the half the
//          hover card structurally cannot show, because listing twelve
//          edges in a panel that follows the mouse is unreadable.
//
// It is the same class of control as the left panel and the viewport (§7):
// it reads the document, writes nothing, sends nothing over the socket
// (§1.6). Clicking a connection RE-SELECTS the far end, which is navigation
// through the graph, not an edit to it.
//
// Left panel answers WHICH ELEMENTS ARE DRAWN. This one answers WHAT ONE OF
// THEM IS. They never share a control, and both can be open at once.

import type { CSSProperties, ReactNode } from 'react';
// Runtime imports of the core SOURCE modules, not the barrel (node:fs) — the
// same route HoverCard.tsx and NodeBox.tsx take.
import { formatBinding } from '../../../core/src/bindings/ref.js';
import { edgeHasReturn, edgeIsAsync } from '../../../core/src/schema/graph.js';
import type { Connection, SelectionView } from '../view/selection.js';
import { bindingHref, type EditorScheme } from './bindingLink.js';
import { fieldDetail, kindText, visibleMeta } from './HoverCard.js';
import { theme } from './theme.js';

/** Width of the panel, px. The canvas sizes itself against this. */
export const DETAIL_WIDTH = 320;

/**
 * The ACTIVE verb for each kind — how the edge reads with its `from` end as
 * the subject, which is the direction rule 4 makes an author write.
 *
 * One phrasing per kind, not two. An earlier version carried a passive form
 * as well ("read by", "published to by") so that an incoming row could put
 * the SELECTED node first, and that is what produced a real bug: an edge with
 * no kind has no passive form to look up, so the row fell back to the raw
 * label and rendered `OpenTofu --creates--> Backup bucket` as "creates
 * OpenTofu" in the bucket's panel — a sentence asserting the exact opposite
 * of the document.
 *
 * Word ORDER carries the direction instead, so nothing has to be conjugated
 * and an arbitrary author label is safe:
 *
 *   outgoing   <verb> <other>     "reads from Postgres", "creates Backup bucket"
 *   incoming   <other> <verb>     "OpenTofu creates", "Web app calls"
 *
 * Both are grammatical with the selected node as the implied missing term,
 * and both survive a label this module has never seen.
 */
const KIND_VERB: Record<string, string> = {
  call: 'calls',
  read: 'reads from',
  write: 'writes to',
  publish: 'publishes to',
  consume: 'consumes from',
};

/**
 * The verb for one connection, always in the ACTIVE voice with the edge's
 * `from` end as the subject. The row decides where to put it; see KIND_VERB.
 */
export function connectionVerb(c: Connection): string {
  const byKind = c.edge.kind === undefined ? undefined : KIND_VERB[c.edge.kind];
  if (byKind !== undefined) return byKind;
  // The author's own label. Rule 4 has them read every edge aloud as
  // "<from> <label> <to>", so a label is already an active verb phrase whose
  // subject is the `from` end — exactly what this returns.
  if (c.edge.label !== undefined) return c.edge.label;
  return 'connects to';
}

export interface DetailPanelProps {
  selection: SelectionView;
  /** Select another node — used by the connection rows to walk the graph. */
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Project root a repo-relative binding resolves against, as `serve` reports it. */
  root?: string | null;
  editor?: EditorScheme;
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 0,
  bottom: 0,
  width: DETAIL_WIDTH,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  padding: '10px 12px 12px',
  overflowY: 'auto',
  background: theme.canvas,
  borderLeft: `1px solid ${theme.node.stroke}`,
  color: theme.text.primary,
  font: '12px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
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
  borderTop: `1px solid ${theme.node.stroke}`,
};

// Every value column in this panel wraps. Same rule as the hover card, same
// reason: a panel that exists to show "all of the information on this node"
// cannot ellipsise the half of it that is long.
const wrapStyle: CSSProperties = { overflowWrap: 'anywhere', minWidth: 0 };

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'baseline',
  padding: '1px 0',
};

const keyStyle: CSSProperties = {
  ...wrapStyle,
  color: theme.text.secondary,
  flex: '0 0 92px',
};

function Section({
  title,
  count,
  testId,
  children,
}: {
  title: string;
  count?: number;
  testId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section data-testid={testId} aria-label={title} style={sectionStyle}>
      <h2 style={headingStyle}>
        {title}
        {count === undefined ? null : (
          <span style={{ fontWeight: 400, marginLeft: 6 }}>{count}</span>
        )}
      </h2>
      {children}
    </section>
  );
}

/**
 * One connection: the far end's name, the verb, and whatever else the edge
 * says about itself. The whole row is a button, because the useful next
 * question after "what is this wired to" is almost always "and what is THAT".
 *
 * The colour bar down the left is the direction, matching the canvas exactly:
 * outgoing wears the selected node's accent, incoming wears ink, and those
 * are the two colours the lines on screen just turned. A reader who wants to
 * know which line a row is looking at matches the colour, not the label.
 */
function ConnectionRow({
  c,
  accent,
  onSelect,
}: {
  c: Connection;
  accent: string;
  onSelect: (id: string) => void;
}): JSX.Element {
  const notes = [
    c.edge.returns === undefined ? undefined : `returns ${c.edge.returns}`,
    edgeIsAsync(c.edge) ? 'async' : undefined,
    c.edge.cardinality,
    c.edge.alt === undefined ? undefined : `alt: ${c.edge.alt}`,
  ].filter((n): n is string => n !== undefined);

  return (
    <button
      type="button"
      data-connection={c.edge.id}
      data-drawn={c.drawnId}
      data-direction={c.direction}
      onClick={() => onSelect(c.otherId)}
      title={`Go to ${c.otherLabel}`}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        borderLeft: `3px solid ${c.direction === 'out' ? accent : theme.text.primary}`,
        borderRadius: 0,
        padding: '3px 0 3px 8px',
        margin: '0 0 4px',
        color: theme.text.primary,
      }}
    >
      <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        {c.edge.seq === undefined ? null : (
          <span
            data-connection-seq={c.edge.seq}
            style={{
              flex: '0 0 auto',
              minWidth: 15,
              textAlign: 'center',
              borderRadius: 8,
              border: `1px solid ${theme.text.primary}`,
              font: '600 9px system-ui, sans-serif',
              lineHeight: '13px',
            }}
          >
            {c.edge.seq}
          </span>
        )}
        {/* The arrow is the direction, said outright rather than left to the
            colour of a 3px bar — which no reader should have to decode, and
            which a colour-blind one cannot. */}
        <span
          aria-hidden="true"
          style={{ flex: '0 0 auto', color: theme.text.secondary }}
        >
          {c.direction === 'out' ? '\u2192' : '\u2190'}
        </span>
        {/* WORD ORDER CARRIES THE DIRECTION. Outgoing reads "<verb> <other>"
            and incoming reads "<other> <verb>", so both are sentences whose
            implied missing term is the node whose panel this is — and neither
            has to conjugate an author's label into a passive it may not have.
            Getting this backwards is what made a bucket's panel claim it
            "creates OpenTofu". */}
        {c.direction === 'out' ? null : (
          <>
            <strong style={{ ...wrapStyle, fontWeight: 600 }}>{c.otherLabel}</strong>
            {c.otherIsGroup ? (
              <span style={{ color: theme.text.secondary, flex: '0 0 auto' }}>(group)</span>
            ) : null}
          </>
        )}
        <span style={{ ...wrapStyle, color: theme.text.secondary, flex: '0 0 auto' }}>
          {connectionVerb(c)}
        </span>
        {/* An incoming row would otherwise end on a dangling preposition —
            "Nightly backup writes to" — because its object is the node whose
            panel this is. Naming it outright would repeat the heading on
            every row, so it gets the pronoun, muted. */}
        {c.direction === 'out' ? null : (
          <span style={{ color: theme.text.secondary, flex: '0 0 auto' }}>this</span>
        )}
        {c.direction === 'out' ? (
          <>
            <strong style={{ ...wrapStyle, fontWeight: 600 }}>{c.otherLabel}</strong>
            {c.otherIsGroup ? (
              <span style={{ color: theme.text.secondary, flex: '0 0 auto' }}>(group)</span>
            ) : null}
          </>
        ) : null}
        {/* Where the edge REALLY lands when a collapse has moved it. Without
            this, a collapsed boundary reports several identical rows and the
            reader cannot tell which relationship is which. */}
        {c.insideLabel === undefined ? null : (
          <span
            data-connection-inside={c.insideLabel}
            style={{ color: theme.text.secondary, flex: '0 0 auto' }}
          >
            ({c.insideLabel})
          </span>
        )}
      </span>
      {notes.length === 0 ? null : (
        <span
          style={{
            display: 'block',
            color: theme.text.secondary,
            fontSize: 11,
            ...wrapStyle,
          }}
        >
          {notes.join(' · ')}
        </span>
      )}
      {/* The return leg, spelled out. On the canvas it is a faint second
          stroke; here it gets a line of its own, because "and something
          comes back" is the fact the old single-arrow picture could not
          state at all. */}
      {!edgeHasReturn(c.edge) ? null : (
        <span
          data-connection-return={c.edge.id}
          style={{ display: 'block', color: theme.text.secondary, fontSize: 11 }}
        >
          {c.direction === 'out' ? '← ' : '→ '}
          {c.edge.returns ?? 'response'} {c.direction === 'out' ? 'comes back' : 'sent back'}
        </span>
      )}
    </button>
  );
}

export function DetailPanel({
  selection,
  onSelect,
  onClose,
  root = null,
  editor = 'vscode',
}: DetailPanelProps): JSX.Element {
  const { node, outgoing, incoming } = selection;
  const meta = visibleMeta(node);
  const fields = node.fields ?? [];
  const bindings = node.bindings ?? [];
  const accent = theme.accent[node.type];

  return (
    <aside style={panelStyle} aria-label="node details" data-testid="detail-panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            data-detail-label
            style={{ font: '600 15px system-ui, sans-serif', ...wrapStyle }}
          >
            {node.label}
          </div>
          <div style={{ color: theme.text.secondary, marginTop: 2 }}>
            <span style={{ color: accent }}>●</span> {kindText(node)}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid="detail-close"
          title="Close (Esc)"
          aria-label="Close node details"
          style={{
            flex: '0 0 auto',
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
          ✕
        </button>
      </div>

      {node.note === undefined ? null : (
        <p data-detail-note style={{ margin: '8px 0 0', ...wrapStyle }}>
          {node.note}
        </p>
      )}

      <div data-detail-id style={{ marginTop: 6, color: theme.text.secondary }}>
        <span style={{ font: '400 11px ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          {node.id}
        </span>
      </div>

      {meta.length === 0 ? null : (
        <Section testId="detail-meta" title="Metadata" count={meta.length}>
          {meta.map(([k, v]) => (
            <div key={k} style={rowStyle} data-detail-meta={k}>
              <span style={keyStyle}>{k}</span>
              <span style={wrapStyle}>{v}</span>
            </div>
          ))}
        </Section>
      )}

      <Section
        testId="detail-outgoing"
        title="Depends on"
        count={outgoing.length}
      >
        {outgoing.length === 0 ? (
          <p style={{ margin: 0, color: theme.text.secondary }}>
            Nothing. No edge leaves this component.
          </p>
        ) : (
          outgoing.map((c) => (
            <ConnectionRow
              key={`${c.drawnId} ${c.edge.id}`}
              c={c}
              accent={accent}
              onSelect={onSelect}
            />
          ))
        )}
      </Section>

      <Section
        testId="detail-incoming"
        title="Depended on by"
        count={incoming.length}
      >
        {incoming.length === 0 ? (
          <p style={{ margin: 0, color: theme.text.secondary }}>
            Nothing. No edge arrives here.
          </p>
        ) : (
          incoming.map((c) => (
            <ConnectionRow
              key={`${c.drawnId} ${c.edge.id}`}
              c={c}
              accent={accent}
              onSelect={onSelect}
            />
          ))
        )}
      </Section>

      {bindings.length === 0 ? null : (
        <Section testId="detail-bindings" title="Read from" count={bindings.length}>
          {bindings.map((b, i) => {
            const text = formatBinding(b);
            const href = bindingHref(b, root, editor);
            const style: CSSProperties = {
              display: 'block',
              padding: '2px 0',
              font: '400 11px ui-monospace, SFMono-Regular, Menlo, monospace',
              ...wrapStyle,
            };
            return href === null ? (
              <span
                key={`${text} ${i}`}
                data-detail-binding={text}
                title={`${text} — nothing to open: this names something inside a file, not a file`}
                style={{ ...style, color: theme.text.secondary }}
              >
                {text}
              </span>
            ) : (
              <a
                key={`${text} ${i}`}
                data-detail-binding={text}
                href={href}
                title={`open ${text}`}
                style={{ ...style, color: theme.text.primary }}
              >
                {text}
              </a>
            );
          })}
        </Section>
      )}

      {fields.length === 0 ? null : (
        <Section testId="detail-fields" title="Fields" count={fields.length}>
          {fields.map((f, i) => (
            <div key={`${f.name} ${i}`} style={rowStyle} data-detail-field={f.name}>
              <span
                style={{
                  ...wrapStyle,
                  flex: '1 1 auto',
                  color: f.nullable === true ? theme.text.secondary : theme.text.primary,
                }}
              >
                {f.name}
              </span>
              <span style={{ ...keyStyle, flex: '0 0 110px', textAlign: 'right' }}>
                {fieldDetail(f)}
              </span>
            </div>
          ))}
        </Section>
      )}

      <p
        data-testid="detail-source"
        style={{
          margin: 'auto 0 0',
          paddingTop: 10,
          color: theme.text.secondary,
        }}
      >
        Reading the diagram, not the running system. Nothing here is saved.
      </p>
    </aside>
  );
}
