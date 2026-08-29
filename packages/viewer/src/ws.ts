// ws.ts — reconnecting WebSocket client for the viewer (spec §2.4, §8.4).
//
// The server (`diagram serve`, spec §9) broadcasts {type:'doc', doc} whenever
// graph.json changes, and {type:'error', errors} when it fails to parse or
// validate. The error frame carries NO doc: it must never repaint or blank
// the canvas — it only tells the status bar to flash amber (§9). This
// client hands each parsed doc to onDoc, each error batch to onError, and reports
// a three-state connection health for the status bar dot:
//   'connected'    — socket open (green)
//   'reconnecting' — disconnected, retrying (amber)
//   'down'         — disconnected for 5s+ (red, spec §8.4)
// Reconnects with doubling backoff (500ms → 5s cap). The WebSocket
// constructor is injectable so the state machine is Node-testable with a
// fake; no DOM access happens at module scope.

import type { GraphDoc } from '@diagram-engine/core';

export type ConnectionState = 'connected' | 'reconnecting' | 'down';

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 5000;
export const DOWN_AFTER_MS = 5000;

/** Minimal structural WebSocket surface, satisfied by the browser's and by fakes. */
export interface WsMessageEvent {
  data: unknown;
}
export interface WebSocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: WsMessageEvent) => void) | null;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

/** A decoded server frame (spec §9). */
export type ServerFrame =
  | { type: 'doc'; doc: GraphDoc }
  | { type: 'error'; errors: string[] };

/**
 * Parse one wire message into a tagged frame, or null for anything
 * unrecognised (never throws — a garbage frame must not kill the socket
 * handlers). The server validates the doc against the zod schema before
 * broadcasting (spec §9), so a structural check suffices here.
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
  const m = msg as { type?: unknown; doc?: unknown; errors?: unknown };
  if (m.type === 'doc') {
    if (typeof m.doc !== 'object' || m.doc === null) return null;
    return { type: 'doc', doc: m.doc as GraphDoc };
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

/** ws(s)://<location.host> per spec §2.4; localhost fallback outside a browser. */
export function defaultWsUrl(): string {
  const loc = (globalThis as { location?: { protocol?: string; host?: string } }).location;
  const proto = loc?.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc?.host ?? '127.0.0.1:4400'}`;
}

export interface ViewerSocketOptions {
  /** Defaults to ws(s)://<location.host>. */
  url?: string;
  onDoc: (doc: GraphDoc) => void;
  onState?: (state: ConnectionState) => void;
  /**
   * A rejected graph.json (§9). Called with the validation messages; the
   * caller must NOT clear the diagram — the last good one stays up.
   */
  onError?: (errors: string[]) => void;
  /** Injectable for tests; defaults to globalThis.WebSocket. */
  webSocket?: WebSocketCtor;
  baseDelayMs?: number;
  maxDelayMs?: number;
  downAfterMs?: number;
}

export interface ViewerSocket {
  readonly state: ConnectionState;
  close(): void;
}

/**
 * Open the reconnecting client. Emits onState only on change:
 * starts 'reconnecting', 'connected' on open, back to 'reconnecting' the
 * moment the socket drops, 'down' once 5s pass without a live connection
 * (further failed attempts while 'down' stay 'down'). close() silences and
 * stops everything.
 */
export function connectViewer(opts: ViewerSocketOptions): ViewerSocket {
  const WS =
    opts.webSocket ??
    ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined);
  if (WS === undefined) throw new Error('no WebSocket implementation available');
  const url = opts.url ?? defaultWsUrl();
  const base = opts.baseDelayMs ?? RECONNECT_BASE_MS;
  const max = opts.maxDelayMs ?? RECONNECT_MAX_MS;
  const downAfter = opts.downAfterMs ?? DOWN_AFTER_MS;

  let state: ConnectionState = 'reconnecting';
  let delay = base;
  let closed = false;
  let sock: WebSocketLike | null = null;
  let downTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

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

  const dial = (): void => {
    if (closed) return;
    let settled = false; // dedupe onerror + onclose from the same socket
    const ws = new WS(url);
    sock = ws;
    ws.onopen = () => {
      if (closed || settled) return;
      delay = base;
      clearDownTimer();
      setState('connected');
    };
    ws.onmessage = (ev) => {
      if (closed) return;
      const frame = parseServerMessage(ev.data);
      if (frame === null) return;
      if (frame.type === 'doc') opts.onDoc(frame.doc);
      else opts.onError?.(frame.errors);
    };
    const dropped = (): void => {
      if (closed || settled) return;
      settled = true;
      if (state !== 'down') setState('reconnecting'); // red stays red until reconnected
      armDownTimer();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        dial();
      }, delay);
      delay = Math.min(delay * 2, max);
    };
    ws.onclose = dropped;
    ws.onerror = dropped;
  };

  opts.onState?.(state); // initial 'reconnecting'
  armDownTimer();
  dial();

  return {
    get state(): ConnectionState {
      return state;
    },
    close(): void {
      if (closed) return;
      closed = true;
      clearDownTimer();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      sock?.close();
      sock = null;
    },
  };
}
