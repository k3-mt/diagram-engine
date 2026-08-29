// debug/DebugCanvas.tsx — the DEBUG renderer (spec M2 Step 9, M3 exit).
//
// Deliberately ugly: grey rectangles, thin polylines, no theme, no icons.
// Its one job is to prove the data flow — fixture -> layout worker (§5.4
// stale-id handling via LayoutClient) -> geometry pipeline -> SVG — and to
// make hop arcs visible (the M3 exit criterion). The product renderer
// (M4, src/render/) replaces this page; do not grow styling here.
//
// The layout runs in a Web Worker when the environment has one; otherwise
// (explicit feature check) an inline WorkerLike runs the same
// handleLayoutRequest on the calling thread — same protocol, same
// staleness handling, deterministic fallback.

import { useEffect, useRef, useState } from 'react';
import type { GraphDoc } from '@diagram-engine/core';
import {
  LayoutClient,
  handleLayoutRequest,
  type LayoutRequest,
  type WorkerLike,
} from '../layout/worker.js';
import { elkWithOwnWorker } from '../layout/elkBrowser.js';
import type { LaidOut } from '../layout/fromElk.js';
import { FIXTURES, type FixtureEntry } from './fixtures.js';
import { buildFrame, type DebugFrame } from './frame.js';

const GREY_STROKE = '#888';
const GREY_FILL = '#e0e0e0';
const GROUP_FILL = '#f2f2f2';
const PAD = 16; // px of breathing room around the fit-to-content viewBox

/**
 * WorkerLike speaking the §5.4 protocol on this thread. The heavy ELK
 * computation still leaves the UI thread: when the environment has
 * Worker, requests run on an ElkEngine backed by elkjs's OWN worker
 * (elk-worker.min.js). We cannot host elk.bundled.js inside a worker we
 * own — in worker scope it registers itself as an elk worker and exports
 * no constructor (see runLayout.ts / elkBrowser.ts) — so the protocol
 * stays inline and LayoutClient's stale-response discarding is unchanged.
 */
function makeLayoutWorker(): { worker: WorkerLike; dispose: () => void } {
  const elk = typeof Worker !== 'undefined' ? elkWithOwnWorker() : undefined;
  const listeners: ((ev: { data: unknown }) => void)[] = [];
  const inline: WorkerLike = {
    postMessage(msg) {
      void handleLayoutRequest(msg as LayoutRequest, elk).then((res) => {
        for (const l of listeners) l({ data: res });
      });
    },
    addEventListener(_type, cb) {
      listeners.push(cb);
    },
  };
  return { worker: inline, dispose: () => void 0 };
}

interface LayoutState {
  doc: GraphDoc;
  laidOut: LaidOut;
}

export function DebugCanvas(): JSX.Element {
  const [fixtureName, setFixtureName] = useState<string>(
    FIXTURES.find((f) => f.ok)?.name ?? FIXTURES[0]?.name ?? '',
  );
  const [rawPolylines, setRawPolylines] = useState(false);
  const [state, setState] = useState<LayoutState | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  const clientRef = useRef<LayoutClient | null>(null);
  // The doc belonging to the LATEST request; LayoutClient only ever
  // delivers the latest response, so pairing through this ref is safe.
  const latestDocRef = useRef<GraphDoc | null>(null);

  useEffect(() => {
    const { worker, dispose } = makeLayoutWorker();
    clientRef.current = new LayoutClient(
      worker,
      (laidOut) => {
        const doc = latestDocRef.current;
        if (doc) {
          setLayoutError(null);
          setState({ doc, laidOut });
        }
      },
      (error) => setLayoutError(error),
    );
    return () => {
      clientRef.current = null;
      dispose();
    };
  }, []);

  const entry: FixtureEntry | undefined = FIXTURES.find(
    (f) => f.name === fixtureName,
  );

  // Request a layout whenever the selected fixture changes (and once the
  // client exists). Stale responses from rapid switching are discarded by
  // LayoutClient (spec §5.4).
  useEffect(() => {
    if (entry?.ok && clientRef.current) {
      latestDocRef.current = entry.doc;
      clientRef.current.request(entry.doc);
    }
  }, [fixtureName, entry?.ok]);

  const frame: DebugFrame | null =
    entry?.ok && state && state.doc === entry.doc
      ? buildFrame(state.doc, state.laidOut)
      : null;

  // Data-flow proof for headless verification: log counts on each render.
  useEffect(() => {
    if (frame) {
      console.log(
        `[debug] fixture=${fixtureName} nodes=${frame.nodes.length} ` +
          `groups=${frame.groups.length} edges=${frame.edges.length} ` +
          `raw=${rawPolylines}`,
      );
    }
  }, [frame, fixtureName, rawPolylines]);

  return (
    <div style={{ fontFamily: 'monospace', padding: 12 }}>
      <h1 style={{ fontSize: 16 }}>diagram-engine — DEBUG renderer (M2/M3)</h1>
      <div style={{ marginBottom: 8 }}>
        <label>
          fixture:{' '}
          <select
            value={fixtureName}
            onChange={(e) => setFixtureName(e.target.value)}
          >
            {FIXTURES.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
                {f.ok ? '' : ' (invalid)'}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          <input
            type="checkbox"
            checked={rawPolylines}
            onChange={(e) => setRawPolylines(e.target.checked)}
          />{' '}
          raw polylines (geometry off)
        </label>
      </div>

      {!entry && <p>no fixture selected</p>}

      {entry && !entry.ok && (
        <div>
          <p>
            fixture <strong>{entry.name}</strong> is invalid (as expected) —
            validation errors:
          </p>
          <ul>
            {entry.errors.map((err, i) => (
              <li key={i}>
                <code>{err}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {entry?.ok && layoutError && (
        <p>
          layout error: <code>{layoutError}</code>
        </p>
      )}

      {entry?.ok && !layoutError && !frame && <p>laying out…</p>}

      {frame && (
        <svg
          viewBox={`${-PAD} ${-PAD} ${frame.width + 2 * PAD} ${
            frame.height + 2 * PAD
          }`}
          style={{
            width: '100%',
            maxWidth: Math.max(frame.width + 2 * PAD, 200),
            border: '1px solid #ccc',
            background: '#fff',
            display: 'block',
          }}
        >
          {/* 1. group rects, outermost first (spec §8.1 z-order rule 1) */}
          {frame.groups.map((g) => (
            <g key={g.id}>
              <rect
                x={g.rect.x}
                y={g.rect.y}
                width={g.rect.width}
                height={g.rect.height}
                fill={GROUP_FILL}
                stroke={GREY_STROKE}
                strokeDasharray="4 4"
              />
              <text
                x={g.rect.x + 6}
                y={g.rect.y + 14}
                fontSize={11}
                fill={GREY_STROKE}
              >
                {g.id}
              </text>
            </g>
          ))}

          {/* 2. edges: composed paths (hop arcs visible) or raw polylines */}
          {frame.edges.map((e) =>
            rawPolylines ? (
              <polyline
                key={e.id}
                points={e.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={GREY_STROKE}
                strokeWidth={1}
              />
            ) : (
              <path
                key={e.id}
                d={e.d}
                fill="none"
                stroke={GREY_STROKE}
                strokeWidth={1}
              />
            ),
          )}

          {/* 3. node rects with id labels */}
          {frame.nodes.map((n) => (
            <g key={n.id}>
              <rect
                x={n.rect.x}
                y={n.rect.y}
                width={n.rect.width}
                height={n.rect.height}
                fill={GREY_FILL}
                stroke={GREY_STROKE}
              />
              <text
                x={n.rect.x + n.rect.width / 2}
                y={n.rect.y + n.rect.height / 2 + 4}
                fontSize={12}
                textAnchor="middle"
                fill="#333"
              >
                {n.id}
              </text>
            </g>
          ))}
        </svg>
      )}

      {entry?.ok && frame && frame.nodes.length === 0 && (
        <p>(empty document — nothing to draw)</p>
      )}
    </div>
  );
}
