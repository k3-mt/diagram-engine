// tests/analysisView.test.ts — M9 analysis overlays in the VIEWER
// (spec §15.5, §18.7; the §7/§1.6 rules they inherit from the view presets).
//
// Five things are under test, in the order the pipeline hits them:
//
//  1. THE PROJECTION. Analysis runs on the FULL document (A2) while the canvas
//     draws the derived one, so every id in an answer has to be mapped onto
//     something on screen — or counted as hidden. This is the part that is
//     easy to get quietly wrong, so it is tested first and hardest.
//  2. THE CONTROLS. [blast] cycles in experiment-backlog order over targets
//     that are actually drawn, [analysis] toggles, the two modes are
//     exclusive, and NEITHER TOUCHES THE DOCUMENT — the same line
//     tests/views.test.ts holds for the view buttons.
//  3. THE PLANS. Which edges get weight, which get the accent, which boxes get
//     a ring, which get a tint, and where the contained boundary is drawn.
//  4. THE HONESTY CONTRACT. core's A4/A5/C2/C3 sentences appear in the caption
//     verbatim, and the caption adds the one blind spot only a picture has:
//     findings the current collapse is hiding.
//  5. THE MARKUP. Rendered with react-dom/server like tests/views.test.ts and
//     tests/render.test.ts: no DOM, no click simulation — the press logic is a
//     pure function and is driven directly.
//
// The whole surface is exercised over a DEEPLY FROZEN document, which turns
// any accidental write into a throw (A1: analysis is a read).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GraphDoc } from '@diagram-engine/core';
import {
  analyse,
  backlog,
  blastRadius,
} from '../../core/src/analysis/index.js';
import { deriveViewDetail } from '../../core/src/view/derive.js';
import type { LaidOut } from '../src/layout/fromElk.js';
import {
  ANALYSIS_ACCENT,
  AnalysisOverlay,
  BlastOverlay,
  EDGE_MASK_ID,
  OVERLAY_EDGE_W_MAX,
  polylineMidpoint,
  weightedEdgeWidth,
} from '../src/render/AnalysisOverlay.js';
import {
  OverlayButtons,
  blastButtonText,
} from '../src/render/OverlayButtons.js';
import {
  OverlayCaption,
  analysisCaption,
  blastCaption,
  collapsedBlindSpot,
  namedList,
} from '../src/render/OverlayCaption.js';
import { StatusBar } from '../src/render/StatusBar.js';
import { analysisPlan, blastPlan, fanInBadge } from '../src/view/overlayPlan.js';
import {
  INITIAL_OVERLAY_STATE,
  blastCandidates,
  buildDrawnIndex,
  canBlast,
  nextBlastTarget,
  projectEdge,
  projectId,
  projectIds,
  resolveOverlay,
  selectOverlay,
  type DrawnIndex,
} from '../src/view/overlayState.js';

// --- fixture ---------------------------------------------------------------
// Two root boundaries, two clients, one synchronous chain four deep, and one
// DASHED edge — which is the whole point of the fixture: without it there is
// no containment to draw, and containment is the design's safety claim.
//
//   web ─┐                                      ┌ platform ┐
//        ├─▶ api ──▶ orders ──▶ db              │ api      │   ┌ data ┐
//   mobile┘                      ▲              │ orders   │   │ db   │
//                     reporting ⇢┘              └──────────┘   └──────┘

const raw: GraphDoc = {
  schemaVersion: 1,
  title: 'Checkout platform',
  direction: 'DOWN',
  groups: [
    { id: 'platform', label: 'Platform', kind: 'vpc', parent: null },
    { id: 'data', label: 'Data', kind: 'vpc', parent: null },
  ],
  nodes: [
    { id: 'web', label: 'Web client', type: 'client', parent: null },
    { id: 'mobile', label: 'Mobile client', type: 'client', parent: null },
    { id: 'api', label: 'API gateway', type: 'service', parent: 'platform' },
    { id: 'orders', label: 'Orders', type: 'service', parent: 'platform' },
    { id: 'reporting', label: 'Reporting', type: 'service', parent: null },
    { id: 'db', label: 'Postgres', type: 'database', parent: 'data' },
  ],
  edges: [
    { id: 'e1', from: 'web', to: 'api', label: 'calls' },
    { id: 'e2', from: 'mobile', to: 'api', label: 'calls' },
    { id: 'e3', from: 'api', to: 'orders', label: 'routes' },
    { id: 'e4', from: 'orders', to: 'db', label: 'reads' },
    { id: 'e5', from: 'reporting', to: 'db', label: 'batch', style: 'dashed' },
  ],
  collapsed: [],
};

/** A1 is tested by freezing: any write anywhere in the surface throws. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(value);
}

const doc = deepFreeze(raw);

/** The two views the tests compare: everything open, and the exec collapse. */
const openIdx: DrawnIndex = buildDrawnIndex(doc, deriveViewDetail(doc, []));
const execIdx: DrawnIndex = buildDrawnIndex(
  doc,
  deriveViewDetail(doc, ['platform', 'data']),
);

// --- 1. the projection (A2) ------------------------------------------------

describe('projecting a full-document answer onto the drawn picture (A2)', () => {
  it('indexes exactly what the derived document draws', () => {
    expect([...openIdx.ids].sort()).toEqual(
      ['api', 'data', 'db', 'mobile', 'orders', 'platform', 'reporting', 'web'].sort(),
    );
    // Collapsed: the insides are gone, the boundaries are boxes.
    expect([...execIdx.ids].sort()).toEqual(
      ['data', 'mobile', 'platform', 'reporting', 'web'].sort(),
    );
  });

  it('maps a hidden node onto the collapsed boundary that swallowed it', () => {
    expect(projectId(openIdx, 'db')).toBe('db');
    expect(projectId(execIdx, 'db')).toBe('data');
    expect(projectId(execIdx, 'orders')).toBe('platform');
    expect(projectId(execIdx, 'web')).toBe('web');
  });

  it('returns null for an id nothing on screen represents', () => {
    expect(projectId(openIdx, 'nope')).toBe(null);
  });

  it('maps a merged edge through deriveView own bookkeeping, not a guess', () => {
    expect(projectEdge(openIdx, 'e4')).toBe('e4');
    // orders -> db becomes the drawn platform -> data edge; api -> orders is
    // internal to the collapsed box and vanishes, so it maps to nothing.
    const drawn = new Set(
      deriveViewDetail(doc, ['platform', 'data']).doc.edges.map((e) => e.id),
    );
    const mapped = projectEdge(execIdx, 'e4');
    expect(mapped).not.toBe(null);
    expect(drawn.has(mapped as string)).toBe(true);
    expect(projectEdge(execIdx, 'e3')).toBe(null);
  });

  it('counts what the projection lost, so the caption can say so (A5)', () => {
    const p = projectIds(execIdx, ['orders', 'api', 'web', 'nope']);
    expect(p.drawn).toEqual(['platform', 'web']); // orders and api both roll up
    expect(p.rolledUp).toBe(2);
    expect(p.dropped).toBe(1);
  });

  it('is cycle-safe on a document that dodged validation', () => {
    const looped: GraphDoc = {
      ...raw,
      groups: [
        { id: 'a', label: 'A', kind: 'vpc', parent: 'b' },
        { id: 'b', label: 'B', kind: 'vpc', parent: 'a' },
      ],
      nodes: [{ id: 'n', label: 'N', type: 'service', parent: 'a' }],
      edges: [],
    };
    const idx = buildDrawnIndex(looped, deriveViewDetail(looped, []));
    expect(projectId(idx, 'n')).toBe('n');
  });
});

// --- 2. the controls (§7, §1.6) -------------------------------------------

describe('[blast] picks a target with no mouse selection (§1.6)', () => {
  it('offers the experiment backlog, in backlog order, not document order', () => {
    const ranked = backlog(doc, { includeGroups: true });
    const offered = blastCandidates(doc, openIdx);
    expect(offered.map((c) => c.id)).toEqual(
      ranked.filter((r) => openIdx.ids.has(r.id)).map((r) => r.id),
    );
    // Entry points are not experiments (§18.4), so no client is offered.
    expect(offered.map((c) => c.id)).not.toContain('web');
    expect(offered.map((c) => c.id)).not.toContain('mobile');
    // The most impactful experiment is what the first press lands on: killing
    // Postgres puts four things at risk, killing the API gateway two.
    expect(offered[0]?.id).toBe('db');
    expect(offered.map((c) => c.id).indexOf('db')).toBeLessThan(
      offered.map((c) => c.id).indexOf('api'),
    );
  });

  it('offers only targets drawn under their own name — boundaries in exec', () => {
    const offered = blastCandidates(doc, execIdx).map((c) => c.id);
    // ...and still in backlog order: the Data outage outranks the Platform one.
    expect(offered).toEqual(['data', 'platform']);
  });

  it('cycles, wraps, and walks backwards on a shift-activate', () => {
    const cands = blastCandidates(doc, openIdx);
    const ids = cands.map((c) => c.id);
    let state = INITIAL_OVERLAY_STATE;
    const seen: (string | null)[] = [];
    for (let i = 0; i < ids.length + 1; i += 1) {
      state = selectOverlay(state, 'blast', cands);
      seen.push(state.target);
    }
    expect(seen).toEqual([...ids, ids[0]]); // first press enters, then advances
    const back = selectOverlay(
      { mode: 'blast', target: ids[0] ?? null },
      'blast',
      cands,
      { reverse: true },
    );
    expect(back.target).toBe(ids[ids.length - 1]);
  });

  it('recovers when a view change hides the target it was pointing at', () => {
    const state = { mode: 'blast' as const, target: 'db' };
    const resolved = resolveOverlay(doc, execIdx, state);
    expect(resolved.target).toBe('data'); // db is not drawn; take the backlog top
    expect(resolved.targetLabel).toBe('Data');
  });

  it('is disabled when nothing on screen can be experimented on', () => {
    const clientsOnly: GraphDoc = {
      ...raw,
      groups: [],
      nodes: [{ id: 'web', label: 'Web', type: 'client', parent: null }],
      edges: [],
    };
    const idx = buildDrawnIndex(clientsOnly, deriveViewDetail(clientsOnly, []));
    expect(canBlast(blastCandidates(clientsOnly, idx))).toBe(false);
    // and a press is a no-op rather than a mode you cannot leave
    expect(selectOverlay(INITIAL_OVERLAY_STATE, 'blast', [])).toBe(
      INITIAL_OVERLAY_STATE,
    );
    expect(nextBlastTarget([], null)).toBe(null);
  });
});

describe('the overlay buttons never touch the document (§1.6)', () => {
  it('toggles [analysis] and keeps the remembered blast target', () => {
    const on = selectOverlay({ mode: 'off', target: 'db' }, 'analysis', []);
    expect(on).toEqual({ mode: 'analysis', target: 'db' });
    expect(selectOverlay(on, 'analysis', [])).toEqual({ mode: 'off', target: 'db' });
  });

  it('keeps the two modes exclusive — no stacked heat maps (§8.2)', () => {
    const cands = blastCandidates(doc, openIdx);
    const blast = selectOverlay(INITIAL_OVERLAY_STATE, 'blast', cands);
    expect(blast.mode).toBe('blast');
    expect(selectOverlay(blast, 'analysis', cands).mode).toBe('analysis');
  });

  it('leaves the document object completely alone', () => {
    const before = JSON.stringify(doc);
    const cands = blastCandidates(doc, openIdx);
    let state = selectOverlay(INITIAL_OVERLAY_STATE, 'blast', cands);
    state = selectOverlay(state, 'blast', cands);
    state = selectOverlay(state, 'analysis', cands);
    analysisPlan(doc, analyse(doc), openIdx);
    blastPlan(blastRadius(doc, 'db'), openIdx);
    expect(JSON.stringify(doc)).toBe(before);
    expect(doc.collapsed).toEqual([]);
  });
});

// --- 3. the plans ----------------------------------------------------------

describe('the analysis plan (§15.5)', () => {
  const analysis = analyse(doc);
  const plan = analysisPlan(doc, analysis, openIdx);

  it('rings exactly the chokepoints core named — no second threshold', () => {
    expect(plan.rings.map((r) => r.id)).toEqual(
      analysis.chokepoints.map((c) => c.id),
    );
    expect(plan.rings.map((r) => r.id)).toContain('api');
    expect(plan.hiddenChokepoints).toBe(0);
  });

  it('hangs §15.4 headline number off the box it belongs to', () => {
    const api = plan.rings.find((r) => r.id === 'api');
    expect(api?.badge).toBe('fan-in 2 (2 sync)');
    expect(fanInBadge(3, 0)).toBe('fan-in 3');
  });

  it('weights only synchronous edges converging on a chokepoint', () => {
    const ids = plan.weighted.map((w) => w.id);
    expect(ids).toContain('e1'); // web -> api, api is a chokepoint
    expect(ids).toContain('e2');
    // e5 is the DASHED edge into db: never thickened, or the one distinction
    // the blast overlay depends on would be painted over (§4.4 rule 6).
    expect(ids).not.toContain('e5');
    expect(plan.weighted.find((w) => w.id === 'e1')?.weight).toBe(2);
  });

  it('highlights the longest synchronous chain and reports its depth', () => {
    expect(plan.chain).toEqual(['e1', 'e3', 'e4']);
    expect(plan.chainDepth).toBe(4);
    expect(plan.chainThroughCycle).toBe(false);
    expect(plan.chainCycleEdges).toEqual([]);
  });

  it('marks a chain step that is a cycle, so it is never drawn as a line', () => {
    const cyclic: GraphDoc = {
      ...raw,
      edges: [
        ...raw.edges,
        { id: 'e6', from: 'db', to: 'orders', label: 'notifies' },
      ],
    };
    const a = analyse(cyclic);
    const p = analysisPlan(cyclic, a, buildDrawnIndex(cyclic, deriveViewDetail(cyclic, [])));
    expect(a.syncCycles.length).toBeGreaterThan(0);
    expect(p.chainThroughCycle).toBe(true);
    expect(p.chainCycleEdges.length).toBeGreaterThan(0);
    // the cycle's own edges are PART of the highlight, and are the ones dashed
    for (const id of p.chainCycleEdges) expect(p.chain).toContain(id);
  });

  it('refuses to ring a collapsed boundary as if it were the chokepoint', () => {
    const collapsed = analysisPlan(doc, analysis, execIdx);
    expect(collapsed.rings).toEqual([]);
    expect(collapsed.hiddenChokepoints).toBe(analysis.chokepoints.length);
  });

  it('runs on the FULL document whatever the view says (A2)', () => {
    // The picture changes; the ANSWER does not. Only the projection differs.
    const open = analyse(doc);
    const asExec = analyse({ ...raw, collapsed: ['platform', 'data'] });
    expect(asExec.chokepoints.map((c) => c.id)).toEqual(
      open.chokepoints.map((c) => c.id),
    );
  });
});

describe('the blast-radius plan (§18.3, §18.7)', () => {
  const blast = blastRadius(doc, 'db');
  const plan = blastPlan(blast, openIdx);

  it('rings the target and tints everything that depends on it', () => {
    expect(plan.target).toBe('db');
    expect(plan.atRisk.sort()).toEqual(['api', 'mobile', 'orders', 'web']);
    expect(plan.atRiskEdges.sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('draws the contained boundary at the dashed edge (C2)', () => {
    expect(blast.contained.map((c) => c.id)).toEqual(['reporting']);
    expect(plan.contained).toEqual(['reporting']);
    expect(plan.containedEdges).toEqual(['e5']);
    // reporting is NOT in the at-risk set: that is the claim being drawn.
    expect(plan.atRisk).not.toContain('reporting');
  });

  it('tints a collapsed boundary that contains something at risk, and counts it', () => {
    const collapsed = blastPlan(blastRadius(doc, 'data'), execIdx);
    expect(collapsed.target).toBe('data');
    expect(collapsed.atRisk.sort()).toEqual(['mobile', 'platform', 'web']);
    expect(collapsed.rolledUp).toBe(2); // api and orders, both inside Platform
    expect(collapsed.dropped).toBe(0);
  });

  it('says nothing at all for an entity target — a table is not a runtime (A4)', () => {
    const erd: GraphDoc = {
      ...raw,
      groups: [],
      nodes: [{ id: 't', label: 'Invoices', type: 'entity', parent: null }],
      edges: [],
    };
    const b = blastRadius(erd, 't');
    const p = blastPlan(b, buildDrawnIndex(erd, deriveViewDetail(erd, [])));
    expect(b.note).not.toBe(null);
    expect(p.atRisk).toEqual([]);
    expect(p.contained).toEqual([]);
  });
});

// --- 4. the honesty contract (A4, A5, C2, C3) -----------------------------

describe('the caption prints core sentences verbatim', () => {
  it('carries every note the analysis produced, unaltered', () => {
    const analysis = analyse(doc);
    const caption = analysisCaption(analysis, analysisPlan(doc, analysis, openIdx));
    for (const note of analysis.notes) expect(caption.notes).toContain(note);
    expect(analysis.notes.length).toBeGreaterThan(0);
  });

  it('carries every assumption the prediction produced, unaltered (C2, C3)', () => {
    const blast = blastRadius(doc, 'db');
    const caption = blastCaption(blast, blastPlan(blast, openIdx));
    for (const a of blast.assumptions) expect(caption.notes).toContain(a);
    expect(caption.notes.join(' ')).toContain('"at risk" is not "will fail"');
  });

  it('adds the one blind spot a picture has that a terminal does not', () => {
    const analysis = analyse(doc);
    const caption = analysisCaption(analysis, analysisPlan(doc, analysis, execIdx));
    expect(caption.notes.join('\n')).toContain('collapsed boundary');
    // and says nothing of the sort when nothing is hidden
    const open = analysisCaption(analysis, analysisPlan(doc, analysis, openIdx));
    expect(open.notes.join('\n')).not.toContain('collapsed boundary');
    expect(collapsedBlindSpot(0, 'chokepoint')).toBe(null);
  });

  it('names the contained set rather than leaving it as an absence (§18.3)', () => {
    const blast = blastRadius(doc, 'db');
    const caption = blastCaption(blast, blastPlan(blast, openIdx));
    expect(caption.rows.join('\n')).toContain('contained (1)');
    expect(caption.rows.join('\n')).toContain('Reporting');
    expect(caption.headline).toBe('blast radius — Postgres');
  });

  it('stops naming past a handful and says how many are left', () => {
    expect(namedList([])).toBe('—');
    expect(namedList(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(
      'a, b, c, d, e, f (+1 more)',
    );
  });
});

// --- 5. the markup ---------------------------------------------------------

/** A hand-built frame: the overlay only consumes geometry, so ELK is not needed. */
const box = (x: number, y: number) => ({ x, y, width: 120, height: 40 });
const laidOut: LaidOut = {
  width: 400,
  height: 400,
  nodes: new Map([
    ['web', box(0, 0)],
    ['mobile', box(160, 0)],
    ['api', box(80, 100)],
    ['orders', box(80, 200)],
    ['reporting', box(260, 200)],
    ['db', box(80, 300)],
    ['platform', box(60, 80)],
    ['data', box(60, 280)],
  ]),
  edges: [
    { id: 'e1', points: [{ x: 60, y: 40 }, { x: 140, y: 100 }] },
    { id: 'e2', points: [{ x: 220, y: 40 }, { x: 140, y: 100 }] },
    { id: 'e3', points: [{ x: 140, y: 140 }, { x: 140, y: 200 }] },
    { id: 'e4', points: [{ x: 140, y: 240 }, { x: 140, y: 300 }] },
    { id: 'e5', points: [{ x: 320, y: 240 }, { x: 200, y: 320 }] },
  ],
};
const paths = laidOut.edges.map(
  (e) =>
    `M ${e.points[0]?.x ?? 0} ${e.points[0]?.y ?? 0} L ${e.points[1]?.x ?? 0} ${e.points[1]?.y ?? 0}`,
);
const nodeIds = ['web', 'mobile', 'api', 'orders', 'reporting', 'db'];

describe('the overlay SVG', () => {
  const analysis = analyse(doc);

  const analysisSvg = renderToStaticMarkup(
    createElement(AnalysisOverlay, {
      plan: analysisPlan(doc, analysis, openIdx),
      laidOut,
      paths,
      nodeIds,
    }),
  );
  const blastSvg = renderToStaticMarkup(
    createElement(BlastOverlay, {
      plan: blastPlan(blastRadius(doc, 'db'), openIdx),
      laidOut,
      paths,
      nodeIds,
    }),
  );

  it('rings the chokepoints and labels them with their fan-in', () => {
    expect(analysisSvg).toContain('data-overlay-ring="api"');
    expect(analysisSvg).toContain('fan-in 2 (2 sync)');
    expect(analysisSvg).toContain(ANALYSIS_ACCENT);
  });

  it('keeps overlay edge strokes behind the node boxes (§8.1 z-order)', () => {
    expect(analysisSvg).toContain(`id="${EDGE_MASK_ID}"`);
    expect(analysisSvg).toContain(`mask="url(#${EDGE_MASK_ID})"`);
    // the mask punches out NODES, never the group containers
    expect(analysisSvg).toContain('maskUnits="userSpaceOnUse"');
  });

  it('spends colour on a handful of elements, not on every box (§8.2)', () => {
    // only the chokepoints are ringed — three boxes out of six, not a tint
    // across the diagram, and no box is filled at all in this mode.
    const rings = analysisSvg.split('data-overlay-ring=').length - 1;
    expect(rings).toBe(3);
    expect(analysisSvg).not.toContain('data-overlay="at-risk"');
    expect(analysisSvg).toContain(ANALYSIS_ACCENT);
    // the weight channel is hueless: ink, at low opacity
    expect(analysisSvg).toContain('data-overlay="weighted-edge"');
  });

  it('tints the at-risk set and draws a firebreak on the containing edge', () => {
    expect(blastSvg).toContain('data-overlay-ring="db"'); // the target
    expect(blastSvg).toContain('data-overlay-node="orders"');
    expect(blastSvg).toContain('data-overlay="at-risk"');
    expect(blastSvg).toContain('data-overlay="firebreak"');
    expect(blastSvg).toContain('data-overlay-ring="reporting"'); // contained
    // containment is drawn in ink, not in a second reassuring hue
    expect(blastSvg).not.toContain('#2E8B69');
  });

  it('renders nothing anywhere near the document — it is markup only', () => {
    expect(analysisSvg).not.toContain('schemaVersion');
    expect(blastSvg).not.toContain('schemaVersion');
  });
});

describe('overlay geometry helpers', () => {
  it('grows edge width with fan-in and then stops', () => {
    expect(weightedEdgeWidth(1)).toBeLessThan(weightedEdgeWidth(4));
    expect(weightedEdgeWidth(50)).toBe(OVERLAY_EDGE_W_MAX);
  });

  it('finds the half-arc-length point and its normal, not a bend', () => {
    const mid = polylineMidpoint([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 100, y: 10 },
    ]);
    expect(mid?.x).toBeCloseTo(45);
    expect(mid?.y).toBeCloseTo(10);
    expect(Math.hypot(mid?.nx ?? 0, mid?.ny ?? 0)).toBeCloseTo(1);
  });

  it('is total on degenerate input', () => {
    expect(polylineMidpoint([])).toBe(null);
    expect(polylineMidpoint([{ x: 1, y: 2 }])).toBe(null);
    expect(polylineMidpoint([{ x: 1, y: 2 }, { x: 1, y: 2 }])).toEqual({
      x: 1,
      y: 2,
      nx: 0,
      ny: 1,
    });
  });
});

// --- the buttons in the slot (§8.4) ---------------------------------------

describe('OverlayButtons in the StatusBar analysis slot', () => {
  const buttons = (
    props: Partial<Parameters<typeof OverlayButtons>[0]> = {},
  ): string =>
    renderToStaticMarkup(
      createElement(OverlayButtons, {
        mode: 'off' as const,
        onSelect: () => undefined,
        ...props,
      }),
    );

  /** The one <button> element carrying `data-testid="overlay-button-<name>"`. */
  const button = (html: string, name: string): string =>
    html.split('<button').find((frag) => frag.includes(`overlay-button-${name}`)) ?? '';

  it('renders both, in order', () => {
    const html = buttons();
    expect(html.indexOf('overlay-button-analysis')).toBeGreaterThan(-1);
    expect(html.indexOf('overlay-button-analysis')).toBeLessThan(
      html.indexOf('overlay-button-blast'),
    );
  });

  it('reports the active overlay through aria-pressed, not colour alone', () => {
    const html = buttons({ mode: 'blast', targetLabel: 'Postgres' });
    expect(button(html, 'blast')).toContain('aria-pressed="true"');
    expect(button(html, 'analysis')).toContain('aria-pressed="false"');
    expect(html).toContain('blast: Postgres');
  });

  it('names its target and shortens a long one so the strip never reflows', () => {
    expect(blastButtonText(null)).toBe('blast');
    expect(blastButtonText('Payments checkout gateway')).toBe(
      'blast: Payments checko…',
    );
  });

  it('disables [blast] rather than leaving it silently inert', () => {
    const html = buttons({ blastEnabled: false });
    expect(button(html, 'blast')).toContain('disabled');
    expect(button(html, 'analysis')).not.toContain('disabled');
  });

  it('sits in its own slot, as its own control group', () => {
    const html = renderToStaticMarkup(
      createElement(StatusBar, {
        title: 'Checkout platform',
        counts: { nodes: 6, groups: 2, edges: 5 },
        connection: 'connected' as const,
        lastUpdate: null,
        analysis: createElement(OverlayButtons, {
          mode: 'analysis' as const,
          onSelect: () => undefined,
        }),
      }),
    );
    expect(html).toContain('data-testid="analysis-slot"');
    expect(html).toContain('aria-label="analysis"');
  });

  it('renders nothing when the slot is not filled — every existing caller', () => {
    const html = renderToStaticMarkup(
      createElement(StatusBar, {
        title: 'Checkout platform',
        counts: { nodes: 6, groups: 2, edges: 5 },
        connection: 'connected' as const,
        lastUpdate: null,
      }),
    );
    expect(html).not.toContain('analysis-slot');
  });
});

describe('OverlayCaption', () => {
  it('renders the headline, the rows and the notes', () => {
    const blast = blastRadius(doc, 'db');
    const html = renderToStaticMarkup(
      createElement(OverlayCaption, {
        caption: blastCaption(blast, blastPlan(blast, openIdx)),
      }),
    );
    expect(html).toContain('data-testid="overlay-caption"');
    expect(html).toContain('blast radius — Postgres');
    expect(html).toContain('at risk (4)');
    expect(html).toContain('data-testid="overlay-caption-notes"');
    // C3, in core's words, on the screen.
    expect(html).toContain('will fail');
  });
});

// ---------------------------------------------------------------------------
// The caption must not restate a structural conclusion the engine deliberately
// refused to compute. In the exec view every drawn box IS a collapsed group,
// so a group target is the COMMON case here, not an edge one.
// ---------------------------------------------------------------------------

describe('a boundary experiment is captioned as one', () => {
  it('does not turn "not applicable" into an asserted "no"', () => {
    const blast = blastRadius(doc, 'data');
    expect(blast.targetKind).toBe('group');
    expect(blast.articulation).toBeNull();
    const caption = blastCaption(blast, blastPlan(blast, execIdx));
    const rows = caption.rows.join('\n');
    expect(rows).not.toContain('articulation  no');
    // core's own sentence, the one the CLI prints
    expect(rows).toContain('a boundary is not a single point of failure');
  });

  it('still asserts "no" for a node that genuinely is not one', () => {
    const blast = blastRadius(doc, 'orders');
    const caption = blastCaption(blast, blastPlan(blast, openIdx));
    expect(caption.rows.join('\n')).toContain('articulation  yes');
    const leaf = blastRadius(doc, 'reporting');
    expect(
      blastCaption(leaf, blastPlan(leaf, openIdx)).rows.join('\n'),
    ).toContain('articulation  no — removing it does not split the diagram');
  });

  it('names what the experiment kills, as the CLI headline does', () => {
    const blast = blastRadius(doc, 'data');
    const caption = blastCaption(blast, blastPlan(blast, execIdx));
    expect(caption.headline).toBe('blast radius — Data (boundary — kills 1 component)');
  });
});
