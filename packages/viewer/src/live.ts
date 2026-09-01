// live.ts — the viewer's live-document client (spec §2.4, §8.4; §16.3).
//
// Was ws.ts, a reconnecting WebSocket client. The server (`diagram serve`,
// §9) only ever PUSHES — {type:'doc', doc} when graph.json changes, and
// {type:'error', errors} when it fails to parse or validate — and the browser
// sends nothing back. That is Server-Sent Events, not WebSockets, and the
// difference is not cosmetic: EventSource is built into the browser (zero
// client dependency, and `ws` leaves the server's tree) and it RECONNECTS
// NATIVELY. The dial loop, the doubling backoff, the base/max delays and the
// settled-socket dedupe all existed to do by hand what the browser already
// does, and are gone.
//
// What survives is the part that was never about transport: the three-state
// health the status bar dot reports (§8.4).
//   'connected'    — stream open (green)
//   'reconnecting' — disconnected, EventSource retrying (amber)
//   'down'         — disconnected for 5s+ (red)
//
// The error frame carries NO doc: it must never repaint or blank the canvas
// (§9) — it only tells the status bar to flash amber.
//
// The EventSource constructor is injectable so the state machine is
// Node-testable with a fake; no DOM access happens at module scope.

import type { GraphDoc } from '@diagram-engine/core';

export type ConnectionState = 'connected' | 'reconnecting' | 'down';

export const DOWN_AFTER_MS = 5000;

/** Where the server publishes the stream (serve/watch.ts EVENTS_PATH). */
export const EVENTS_PATH = '/__diagram/events';

/** Minimal structural EventSource surface, satisfied by the browser's and by fakes. */
export interface SseMessageEvent {
  data: unknown;
}
export interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: SseMessageEvent) => void) | null;
  close(): void;
}
export type EventSourceCtor = new (url: string) => EventSourceLike;

/** A decoded server frame (spec §9). */
export type ServerFrame =
  // `root` is the project root a repo-relative binding ref resolves against
  // (§3.8) — the same root `diagram check --bindings` uses. It is what turns a
  // binding chip in the hover panel into a link that opens the file (P5-03),
  // and it is optional: an older server sends no root, and then a chip is text
  // rather than a link that would point at a guess.
  | { type: 'doc'; doc: GraphDoc; root: string | null }
  | { type: 'error'; errors: string[] };

/**
 * Parse one wire message into a tagged frame, or null for anything
 * unrecognised (never throws — a garbage frame must not kill the handlers).
 * The server validates the doc against the zod schema before broadcasting
 * (spec §9), so a structural check suffices here.
 */
export function parseServerMessage(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as { type?: unknown; doc?: unknown; errors?: unknown; root?: unknown };
  if (m.type === 'doc') {
    if (typeof m.doc !== 'object' || m.doc === null) return null;
    return {
      type: 'doc',
      doc: m.doc as GraphDoc,
      root: typeof m.root === 'string' && m.root !== '' ? m.root : null,
    };
  }
  if (m.type === 'error') {
    if (!Array.isArray(m.errors)) return null;
    const errors = m.errors.filter((e): e is string => typeof e === 'string');
    return { type: 'error', errors };
  }
  return null;
}

/**
 * The doc from a well-formed {type:'doc'} frame, else null. Kept as the
 * narrow helper for callers that only care about repaints.
 */
export function parseDocMessage(data: unknown): GraphDoc | null {
  const frame = parseServerMessage(data);
  return frame !== null && frame.type === 'doc' ? frame.doc : null;
}

/**
 * The stream URL: same origin as the page (§2.4), localhost outside a browser.
 * Same-origin means no scheme juggling — the ws/wss switch the WebSocket
 * client needed has no counterpart here.
 */
export function defaultEventsUrl(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return `${loc?.origin ?? 'http://127.0.0.1:4400'}${EVENTS_PATH}`;
}

export interface ViewerStreamOptions {
  /** Defaults to <origin>/__diagram/events. */
  url?: string;
  /** `root` is the project root binding refs resolve against, or null. */
  onDoc: (doc: GraphDoc, root: string | null) => void;
  onState?: (state: ConnectionState) => void;
  /**
   * A rejected graph.json (§9). Called with the validation messages; the
   * caller must NOT clear the diagram — the last good one stays up.
   */
  onError?: (errors: string[]) => void;
  /** Injectable for tests; defaults to globalThis.EventSource. */
  eventSource?: EventSourceCtor;
  downAfterMs?: number;
}

export interface ViewerStream {
  readonly state: ConnectionState;
  close(): void;
}

/**
 * Open the live client. Emits onState only on change: starts 'reconnecting',
 * 'connected' on open, back to 'reconnecting' the moment the stream drops,
 * 'down' once 5s pass without a live connection (further failures while
 * 'down' stay 'down'). close() silences and stops everything.
 *
 * EventSource retries on its own — including honouring the server's `retry:`
 * hint — so there is nothing to redial here. onerror fires on each failure
 * and the browser schedules the next attempt.
 */
export function connectViewer(opts: ViewerStreamOptions): ViewerStream {
  const ES =
    opts.eventSource ??
    ((globalThis as { EventSource?: unknown }).EventSource as EventSourceCtor | undefined);
  if (ES === undefined) throw new Error('no EventSource implementation available');
  const url = opts.url ?? defaultEventsUrl();
  const downAfter = opts.downAfterMs ?? DOWN_AFTER_MS;

  let state: ConnectionState = 'reconnecting';
  let closed = false;
  let downTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (s: ConnectionState): void => {
    if (closed || s === state) return;
    state = s;
    opts.onState?.(s);
  };

  const clearDownTimer = (): void => {
    if (downTimer !== null) {
      clearTimeout(downTimer);
      downTimer = null;
    }
  };

  /** One 5s fuse per outage; when it burns, the dot goes red. */
  const armDownTimer = (): void => {
    if (downTimer !== null) return;
    downTimer = setTimeout(() => {
      downTimer = null;
      setState('down');
    }, downAfter);
  };

  const es = new ES(url);
  es.onopen = () => {
    if (closed) return;
    clearDownTimer();
    setState('connected');
  };
  es.onmessage = (ev) => {
    if (closed) return;
    const frame = parseServerMessage(ev.data);
    if (frame === null) return;
    if (frame.type === 'doc') opts.onDoc(frame.doc, frame.root);
    else opts.onError?.(frame.errors);
  };
  es.onerror = () => {
    if (closed) return;
    // EventSource is already scheduling the retry. All that is left is to
    // say so, and to keep red red until the stream is actually back.
    if (state !== 'down') setState('reconnecting');
    armDownTimer();
  };

  opts.onState?.(state); // initial 'reconnecting'
  armDownTimer();

  return {
    get state(): ConnectionState {
      return state;
    },
    close(): void {
      if (closed) return;
      closed = true;
      clearDownTimer();
      es.close();
    },
  };
}
