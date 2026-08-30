// render/StatusBar.tsx — the thin bottom strip (spec §8.4).
//
//   Checkout platform   11 nodes · 2 groups · 9 edges   [exec] [eng] [focus]
//   ● connected                     last update 2s ago   [SVG ⌘S] [PNG 2×]
//
// Everything the browser window needs, given the terminal is elsewhere.
// The connection dot matters: when the agent's MCP process dies or
// `diagram serve` is restarted, the user must see it here rather than
// wonder why the diagram stopped updating. Green connected, amber on
// reconnect, red after 5s down.
//
// The [exec] [eng] [focus] view buttons (M7) go in the optional `views` slot,
// which main.tsx fills with <ViewButtons>. The bar itself stays dumb about
// views: it is handed a node and gives it a place to sit, so the strip has no
// opinion about collapse and the button logic stays in view/viewState.ts.
// Without the slot nothing is rendered, which is what every existing caller
// and test relies on. The `save` slot at the far right works the same way and
// holds <SaveButtons> — the ⌘S of the §8.4 mock, finally attached to
// something (export/save.ts). The `analysis` slot beside `views` is M9's
// [analysis] [blast: X] overlays (§15.5, §18.7), and follows the same rule:
// the bar is handed a node and gives it a place to sit.
//
// §9: when graph.json fails to parse or validate the server keeps the last
// good diagram on screen and sends {type:'error'} instead of a repaint. The
// bar FLASHES AMBER and then holds an amber message, so the user knows their
// last patch was rejected rather than staring at a stale picture under a
// green dot.

import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ConnectionState } from '../ws.js';
import { theme } from './theme.js';

/** Counts shown in the strip. Kept as plain numbers so the bar never walks the doc. */
export interface StatusCounts {
  nodes: number;
  groups: number;
  edges: number;
}

/** Dot colour per connection state (spec §8.4). */
export const CONNECTION_COLOR: Record<ConnectionState, string> = {
  connected: '#2E8B69', // green
  reconnecting: '#C4791E', // amber
  down: '#B8452F', // red
};

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'connected',
  reconnecting: 'reconnecting',
  down: 'disconnected',
};

/** The amber used for a rejected document (§9), matching the reconnect dot. */
export const ERROR_COLOR = '#C4791E';

/** How long the bar stays lit after a rejection, ms. */
export const FLASH_MS = 1200;

/** A rejected graph.json. `at` is epoch ms, and retriggers the flash. */
export interface DocError {
  /** Validation messages, exactly as the server sent them. */
  errors: string[];
  at: number;
}

/**
 * readDoc prefixes file-level errors with the absolute graph.json path
 * (right for errors.txt, useless in a 28px strip — it would eat the whole
 * line). Drop that prefix for display only; the full text stays in the
 * title attribute and in errors.txt.
 */
function stripPathPrefix(message: string): string {
  return message.replace(/^\s*\/\S*graph\.json:\s*/, '');
}

/**
 * One line for the strip: the first validation message, shortened. The full
 * text goes in the element's title (and, for agents, .diagram/errors.txt).
 */
export function docErrorText(errors: string[], max = 60): string {
  const first = errors.find((e) => e.trim() !== '')?.trim() ?? 'invalid graph.json';
  const oneLine = stripPathPrefix(first.split('\n')[0]!) || 'invalid graph.json';
  const short = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  return `graph.json rejected — ${short}${more}`;
}

/**
 * True for `ms` after `trigger` changes to a new non-null value — the amber
 * flash (§9). Re-fires on every rejection, even an identical one, because
 * `at` is a fresh timestamp each time.
 */
export function useFlash(trigger: number | null, ms: number = FLASH_MS): boolean {
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (trigger === null) {
      setLit(false);
      return;
    }
    setLit(true);
    const id = setTimeout(() => setLit(false), ms);
    return () => clearTimeout(id);
  }, [trigger, ms]);
  return lit;
}

/** "3 nodes · 1 group · 4 edges" — singular/plural handled. */
export function countsText(c: StatusCounts): string {
  const one = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${one(c.nodes, 'node')} · ${one(c.groups, 'group')} · ${one(c.edges, 'edge')}`;
}

/**
 * "last update 2s ago" from a millisecond age. Under a second reads "just
 * now"; past a minute it switches to whole minutes so the strip stays short.
 */
export function lastUpdateText(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'last update just now';
  const s = Math.floor(ageMs / 1000);
  if (s < 1) return 'last update just now';
  if (s < 60) return `last update ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `last update ${m}m ago`;
  return `last update ${Math.floor(m / 60)}h ago`;
}

/** Re-render every `intervalMs` so the "Xs ago" label keeps counting up. */
export function useElapsed(sinceMs: number | null, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (sinceMs === null) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [sinceMs, intervalMs]);
  return sinceMs === null ? 0 : Math.max(0, now - sinceMs);
}

export interface StatusBarProps {
  title: string;
  counts: StatusCounts;
  connection: ConnectionState;
  /** Epoch ms of the last doc received; null before the first one arrives. */
  lastUpdate: number | null;
  /**
   * The most recent rejected graph.json (§9), or null once a good doc has
   * arrived. Non-null turns the bar amber; a new `at` re-flashes it.
   */
  docError?: DocError | null;
  /** Flash duration, ms (tests pass a short one). */
  flashMs?: number;
  /** M7 view buttons ([exec] [eng] [focus]); nothing is rendered without it. */
  views?: ReactNode;
  /**
   * M9 analysis overlays ([analysis] [blast: X], §15.5/§18.7); nothing is
   * rendered without it. A slot of its own rather than more children in
   * `views`: the view presets change WHICH ELEMENTS are drawn, the overlays
   * change WHAT IS SAID ABOUT THEM, and they are separate `role="group"`s so
   * a screen reader announces two controls rather than one of five buttons.
   */
  analysis?: ReactNode;
  /** M7 save controls ([SVG ⌘S] [PNG 2×]); nothing is rendered without it. */
  save?: ReactNode;
  /** Tick period for the elapsed label, ms (tests pass a short one). */
  tickMs?: number;
}

/** Height of the strip, px. The canvas above it sizes itself against this. */
export const BAR_HEIGHT = 28;

const barStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  height: BAR_HEIGHT,
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '0 12px',
  boxSizing: 'border-box',
  background: theme.canvas,
  borderTop: `1px solid ${theme.node.stroke}`,
  color: theme.text.secondary,
  font: '12px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  userSelect: 'none',
};

export function StatusBar(props: StatusBarProps): JSX.Element {
  const {
    title,
    counts,
    connection,
    lastUpdate,
    views,
    analysis,
    save,
    tickMs = 1000,
    docError = null,
    flashMs = FLASH_MS,
  } = props;
  const ageMs = useElapsed(lastUpdate, tickMs);
  const flashing = useFlash(docError?.at ?? null, flashMs);

  // Amber while a rejection stands; brighter for the first FLASH_MS of it.
  const errorStyle: CSSProperties =
    docError === null
      ? {}
      : {
          background: flashing ? '#F7E2C0' : '#FBF1E2',
          borderTop: `1px solid ${ERROR_COLOR}`,
          transition: 'background 200ms ease',
        };

  return (
    <div
      style={{ ...barStyle, ...errorStyle }}
      role="status"
      aria-live="polite"
      data-testid="status-bar"
      data-doc-error={docError === null ? undefined : 'true'}
      data-flashing={flashing ? 'true' : undefined}
    >
      <span style={{ color: theme.text.primary, fontWeight: 600 }}>{title}</span>
      <span>{countsText(counts)}</span>
      {views === undefined || views === null ? null : (
        <span
          data-testid="view-slot"
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          {views}
        </span>
      )}
      {analysis === undefined || analysis === null ? null : (
        <span
          data-testid="analysis-slot"
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          {analysis}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden="true"
          data-testid="connection-dot"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: CONNECTION_COLOR[connection],
            display: 'inline-block',
          }}
        />
        <span>{CONNECTION_LABEL[connection]}</span>
      </span>
      {docError === null ? (
        <span>{lastUpdate === null ? 'waiting for first update' : lastUpdateText(ageMs)}</span>
      ) : (
        <span
          data-testid="doc-error"
          title={docError.errors.join('\n')}
          style={{ color: ERROR_COLOR, fontWeight: 600 }}
        >
          {docErrorText(docError.errors)}
        </span>
      )}
      {save === undefined || save === null ? null : (
        <span
          data-testid="save-slot"
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          {save}
        </span>
      )}
    </div>
  );
}
