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
  ASSUMPTION_NO_REDUNDANCY,
  analyse,
  backlog,
  blastRadius,
  blastRadiusMulti,
} from '../../core/src/analysis/index.js';
import { deriveViewDetail } from '../../core/src/view/derive.js';
import type { LaidOut } from '../src/layout/fromElk.js';
import {
  ANALYSIS_ACCENT,
  AnalysisOverlay,
  BlastOverlay,
  EDGE_MASK_ID,
  OVERLAY_EDGE_W_MAX,
  TARGET_HALO_PAD,
  polylineMidpoint,
  weightedEdgeWidth,
} from '../src/render/AnalysisOverlay.js';
import {
  OverlayButtons,
  blastButtonText,
} from '../src/render/OverlayButtons.js';
import {
  HOW_TO_TARGET,
  OverlayCaption,
  analysisCaption,
  blastCaption,
  collapsedBlindSpot,
  namedList,
} from '../src/render/OverlayCaption.js';
import { StatusBar } from '../src/render/StatusBar.js';
import { theme } from '../src/render/theme.js';
import {
  MAX_EDGE_ACCENT_TARGETS,
  analysisPlan,
  blastPlan,
  fanInBadge,
} from '../src/view/overlayPlan.js';
import {
  INITIAL_OVERLAY_STATE,
  MAX_BLAST_TARGETS,
  blastCandidates,
  blastSelection,
  blastTargets,
  buildDrawnIndex,
  canBlast,
  clearBlastTargets,
  nextBlastTarget,
  toggleBlastTarget,
  projectEdge,
  projectId,
  projectIds,
  resolveOverlay,
  resolveOverlayFrom,
  selectOverlay,
  type DrawnIndex,
  type OverlayState,
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
      seen.push(state.targets[0] ?? null);
    }
    expect(seen).toEqual([...ids, ids[0]]); // first press enters, then advances
    const back = selectOverlay(
      { mode: 'blast', targets: ids.slice(0, 1) },
      'blast',
      cands,
      { reverse: true },
    );
    expect(back.targets).toEqual([ids[ids.length - 1]]);
  });

  it('recovers when a view change hides the target it was pointing at', () => {
    const state = { mode: 'blast' as const, targets: ['db'] };
    const resolved = resolveOverlay(doc, execIdx, state);
    expect(resolved.targets).toEqual(['data']); // db is not drawn; take the backlog top
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
    const on = selectOverlay({ mode: 'off', targets: ['db'] }, 'analysis', []);
    expect(on).toEqual({ mode: 'analysis', targets: ['db'] });
    expect(selectOverlay(on, 'analysis', [])).toEqual({ mode: 'off', targets: ['db'] });
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
    blastPlan(blastRadiusMulti(doc, ['db']), openIdx);
    expect(JSON.stringify(doc)).toBe(before);
    expect(doc.collapsed).toEqual([]);
  });
});

// --- 2b. click to target, modifier-click to combine (§18.7) ---------------
//
// The gestures are pure transitions over ONE field, so they are driven
// directly here: no DOM, no synthetic events, exactly as the button press is.
// The renderer's only job is to hand an id and a modifier to these functions,
// and Canvas.tsx does nothing else.

const blastMode = (targets: string[]): OverlayState => ({ mode: 'blast', targets });

describe('clicking a node targets it (§18.7)', () => {
  it('targets what was clicked, and clears it when clicked again', () => {
    const one = toggleBlastTarget(blastMode([]), 'orders');
    expect(one.targets).toEqual(['orders']);
    // "Clicking again clears it" — and clearing means EMPTY, not a silent
    // re-seed from the backlog, or the second click would look like a no-op.
    expect(toggleBlastTarget(one, 'orders').targets).toEqual([]);
    // A different node replaces rather than accumulates: plain click is
    // "target this", not "add this".
    expect(toggleBlastTarget(one, 'db').targets).toEqual(['db']);
  });

  it('targets a node the BACKLOG excludes — a click is the user asking anyway', () => {
    // Entry points are not RANKED experiments (§18.4), but "what if the web
    // client dies" is still a question, and the answer is a real one.
    expect(blastCandidates(doc, openIdx).map((c) => c.id)).not.toContain('web');
    const clicked = toggleBlastTarget(blastMode([]), 'web');
    expect(clicked.targets).toEqual(['web']);
    // and it survives resolution, because it is DRAWN even though it is not
    // a candidate — the recovery rule must not eat a deliberate choice.
    expect(resolveOverlay(doc, openIdx, clicked).targets).toEqual(['web']);
    expect(blastRadiusMulti(doc, ['web']).atRisk).toEqual([]);
  });

  it('is a no-op outside blast mode — a click has no hidden meaning', () => {
    for (const mode of ['off', 'analysis'] as const) {
      const state: OverlayState = { mode, targets: [] };
      expect(toggleBlastTarget(state, 'db')).toBe(state);
      expect(toggleBlastTarget(state, 'db', { extend: true })).toBe(state);
    }
  });
});

describe('modifier-click combines targets, and the union is core\u2019s (§18.7)', () => {
  it('toggles membership in and out, keeping selection order', () => {
    let state = toggleBlastTarget(blastMode([]), 'db');
    state = toggleBlastTarget(state, 'api', { extend: true });
    state = toggleBlastTarget(state, 'orders', { extend: true });
    expect(state.targets).toEqual(['db', 'api', 'orders']);
    state = toggleBlastTarget(state, 'api', { extend: true });
    expect(state.targets).toEqual(['db', 'orders']);
  });

  it('tints the UNION, not one target\u2019s answer', () => {
    const both = blastRadiusMulti(doc, ['db', 'reporting']);
    const plan = blastPlan(both, openIdx);
    expect(plan.targets).toEqual(['db', 'reporting']);
    // reporting is CONTAINED from db (the dashed edge) but is itself a
    // target, so it is killed, not at risk, and never reported as contained.
    expect(plan.contained).not.toContain('reporting');
    expect(plan.atRisk).not.toContain('reporting');
    // and the at-risk set still holds everything db alone put at risk.
    for (const id of blastPlan(blastRadiusMulti(doc, ['db']), openIdx).atRisk) {
      expect(plan.atRisk).toContain(id);
    }
  });

  it('caps the set rather than turning the canvas into a heat map (§8.2)', () => {
    const many = Array.from({ length: MAX_BLAST_TARGETS }, (_, i) => `n${i}`);
    const full = blastMode(many);
    // the refused click returns the SAME state — no partial drop, no silent
    // eviction of the oldest target
    expect(toggleBlastTarget(full, 'one-more', { extend: true })).toBe(full);
    // removing one makes room again
    const room = toggleBlastTarget(full, 'n0', { extend: true });
    expect(toggleBlastTarget(room, 'one-more', { extend: true }).targets).toHaveLength(
      MAX_BLAST_TARGETS,
    );
    // a PLAIN click is never refused: it replaces the whole selection
    expect(toggleBlastTarget(full, 'one-more').targets).toEqual(['one-more']);
  });

  it('draws one ring per target and drops the halo past one (§8.2)', () => {
    const svg = (ids: string[]): string =>
      renderToStaticMarkup(
        createElement(BlastOverlay, {
          plan: blastPlan(blastRadiusMulti(doc, ids), openIdx),
          laidOut,
          paths,
          nodeIds,
        }),
      );
    const one = svg(['db']);
    const three = svg(['db', 'api', 'orders']);
    expect(one.split('data-overlay="blast-target"').length - 1).toBe(1);
    expect(three.split('data-overlay="blast-target"').length - 1).toBe(3);
    for (const id of ['db', 'api', 'orders']) {
      expect(three).toContain(`data-overlay-ring="${id}"`);
    }
    // the bullseye halo is the single-target flourish; several targets get
    // the ring alone, so the accent is spent once per finding.
    expect(one.split(`ry="${theme.node.radius + TARGET_HALO_PAD}"`).length - 1).toBe(1);
    expect(three).not.toContain(`ry="${theme.node.radius + TARGET_HALO_PAD}"`);
    // and past MAX_EDGE_ACCENT_TARGETS the union's own channel stands down:
    // the edge accents, which are what actually grows with n.
    expect(one).toContain('data-overlay="at-risk-edge"');
    expect(three).not.toContain('data-overlay="at-risk-edge"');
  });

  it('draws the components a targeted boundary kills, not just what it endangers', () => {
    const svg = renderToStaticMarkup(
      createElement(BlastOverlay, {
        plan: blastPlan(blastRadiusMulti(doc, ['platform']), openIdx),
        laidOut,
        paths,
        nodeIds,
      }),
    );
    // api and orders live inside Platform: the experiment destroys them, so
    // they are absent from `atRisk` — and used to be drawn like survivors.
    expect(svg).toContain('data-overlay="killed"');
    for (const id of ['api', 'orders']) {
      expect(svg).toContain(`data-overlay="killed" data-overlay-node="${id}"`);
    }
    // and a node-only experiment kills nothing beyond its target
    const single = renderToStaticMarkup(
      createElement(BlastOverlay, {
        plan: blastPlan(blastRadiusMulti(doc, ['db']), openIdx),
        laidOut,
        paths,
        nodeIds,
      }),
    );
    expect(single).not.toContain('data-overlay="killed"');
  });
});

describe('clearing is one gesture, and cycling replaces a selection', () => {
  it('clears the whole set at once, staying in the mode', () => {
    const state = clearBlastTargets(blastMode(['db', 'api', 'orders']));
    expect(state).toEqual({ mode: 'blast', targets: [] });
    // and an empty selection is drawn as empty, never as the backlog top
    expect(blastTargets(state, blastCandidates(doc, openIdx), openIdx.ids)).toEqual([]);
    expect(clearBlastTargets(state)).toBe(state); // idempotent, no re-render
  });

  it('replaces a multi-selection with the single next backlog entry', () => {
    const cands = blastCandidates(doc, openIdx);
    const next = selectOverlay(blastMode(['db', 'api']), 'blast', cands, {
      drawn: openIdx.ids,
    });
    // Not "advance the primary and keep the rest": the whole selection goes,
    // visibly, and the caption immediately names one target.
    expect(next.targets).toHaveLength(1);
    expect(next.targets[0]).toBe(nextBlastTarget(cands, 'db'));
  });

  it('re-enters the backlog from an empty selection', () => {
    const cands = blastCandidates(doc, openIdx);
    const entered = selectOverlay({ mode: 'off', targets: [] }, 'blast', cands);
    expect(entered.targets).toEqual([cands[0]?.id]);
    // pressing while ON with nothing selected walks from the top too
    const walked = selectOverlay(blastMode([]), 'blast', cands);
    expect(walked.targets).toEqual([cands[0]?.id]);
  });
});

describe('the cap is counted on the list the screen is showing', () => {
  it('refuses a click only when the VISIBLE selection is full, and then says so', () => {
    // The divergence this pins: the cap used to be measured on raw state
    // while `capped` — and the rings, and the button — came from the
    // drawn-filtered list. Eight targets remembered from another view refused
    // every click while the caption reported one target and no cap: a click
    // that did nothing with its reason nowhere on screen.
    const stale = Array.from({ length: MAX_BLAST_TARGETS }, (_, i) => `gone${i}`);
    const state: OverlayState = { mode: 'blast', targets: stale };
    const only = blastCandidates(doc, openIdx).filter((c) => c.id === 'db');
    const resolved = resolveOverlayFrom(only, state, { drawn: new Set(['db']) });
    expect(resolved.targets).toEqual(['db']);
    expect(resolved.capped).toBe(false);

    // so the click must be ACCEPTED, and it must not append to the stale list
    const next = toggleBlastTarget(state, 'db', {
      extend: true,
      drawn: new Set(['db']),
    });
    expect(next).not.toBe(state);
    expect(next.targets).toEqual(['db']);
  });

  it('still refuses once the visible selection really is full, with capped set', () => {
    const drawn = new Set(
      Array.from({ length: MAX_BLAST_TARGETS }, (_, i) => `n${i}`),
    );
    const state: OverlayState = { mode: 'blast', targets: [...drawn] };
    const opts = { extend: true, drawn };
    expect(toggleBlastTarget(state, 'extra', opts)).toBe(state);
    expect(resolveOverlayFrom([], state, { drawn }).capped).toBe(true);
  });

  it('with no index to hand, every remembered target still counts', () => {
    // The pre-existing contract for callers that have no drawn set.
    const state = blastMode(['db']);
    expect(toggleBlastTarget(state, 'db').targets).toEqual([]);
    expect(toggleBlastTarget(state, 'api', { extend: true }).targets).toEqual([
      'db',
      'api',
    ]);
  });
});

describe('selecting, toggling and clearing never write the document (§1.6)', () => {
  it('emits no patch, no write and no socket send — only local state', () => {
    const before = JSON.stringify(doc);
    const cands = blastCandidates(doc, openIdx);

    // every gesture in the surface, over a DEEPLY FROZEN document: a write
    // anywhere in this chain throws rather than passing quietly.
    let state = selectOverlay(INITIAL_OVERLAY_STATE, 'blast', cands, {
      drawn: openIdx.ids,
    });
    state = toggleBlastTarget(state, 'db');
    state = toggleBlastTarget(state, 'api', { extend: true });
    state = toggleBlastTarget(state, 'api', { extend: true });
    state = toggleBlastTarget(state, 'db');
    state = toggleBlastTarget(state, 'orders', { extend: true });
    state = clearBlastTargets(state);
    state = selectOverlay(state, 'blast', cands, { drawn: openIdx.ids });

    const answer = blastRadiusMulti(doc, ['db', 'api']);
    blastPlan(answer, openIdx);
    blastCaption(answer, blastPlan(answer, openIdx));
    resolveOverlay(doc, openIdx, state);

    expect(JSON.stringify(doc)).toBe(before);
    expect(doc.collapsed).toEqual([]);
    // and nothing in the state names a document field: it is a lens, and
    // §18.7 says there must never be a schema field for it.
    expect(Object.keys(state).sort()).toEqual(['mode', 'targets']);
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
  const blast = blastRadiusMulti(doc, ['db']);
  const plan = blastPlan(blast, openIdx);

  it('rings the target and tints everything that depends on it', () => {
    expect(plan.targets).toEqual(['db']);
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
    const collapsed = blastPlan(blastRadiusMulti(doc, ['data']), execIdx);
    expect(collapsed.targets).toEqual(['data']);
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
    const b = blastRadiusMulti(erd, ['t']);
    const p = blastPlan(b, buildDrawnIndex(erd, deriveViewDetail(erd, [])));
    expect(b.note).not.toBe(null);
    expect(p.atRisk).toEqual([]);
    expect(p.contained).toEqual([]);
  });
});

// --- 3b. what a combined prediction must not hide -------------------------

describe('a combined prediction says what it kills and what it left out', () => {
  it('marks the components a targeted boundary kills, so they are not drawn as survivors', () => {
    // In the exec view every drawn box IS a boundary, so this is the normal
    // case, not a corner. `killed` is absent from `atRisk` by construction —
    // those components are past risk — and before this it got no mark at all.
    const b = blastRadiusMulti(doc, ['platform', 'data']);
    const plan = blastPlan(b, openIdx);
    expect(plan.targets).toEqual(['platform', 'data']); // both drawn open
    // the ringed boundaries are excluded — they already carry a ring — and
    // what is left is the three components the experiment destroys outright.
    expect(plan.killed.sort()).toEqual(['api', 'db', 'orders']);
    for (const id of plan.killed) expect(plan.atRisk).not.toContain(id);
    // and never a target: a target already carries a ring.
    const one = blastPlan(blastRadiusMulti(doc, ['data']), execIdx);
    expect(one.targets).toEqual(['data']);
    expect(one.killed).toEqual([]); // db is inside it and not drawn
  });

  it('prints a kills row for a combined boundary experiment, as the single case does', () => {
    const b = blastRadiusMulti(doc, ['platform', 'data']);
    const caption = blastCaption(b, blastPlan(b, execIdx));
    // 2 targets + api, orders, db killed inside them.
    expect(b.killed.length - b.resolved.length).toBe(3);
    expect(caption.rows.join('\n')).toContain('kills (3)');
    expect(caption.rows.join('\n')).toContain('already gone, not merely at risk');
  });

  it('drops a target the view no longer draws — and says so, in the rows', () => {
    // The regression this pins: with TWO targets the backlog-top recovery
    // never fires, so a target the exec view collapsed simply vanished from
    // the answer and the caption reported the smaller experiment as if it had
    // been chosen. Under-reporting a union is the mirror of the over-reporting
    // §18.11 makes us print a caveat about.
    const state: OverlayState = { mode: 'blast', targets: ['db', 'reporting'] };
    const cands = blastCandidates(doc, execIdx);
    const sel = blastSelection(state, cands, execIdx.ids);
    expect(sel.targets).toEqual(['reporting']);
    expect(sel.hidden).toEqual(['db']);
    expect(resolveOverlay(doc, execIdx, state).hiddenTargets).toEqual(['db']);

    const b = blastRadiusMulti(doc, sel.targets);
    const caption = blastCaption(b, blastPlan(b, execIdx, { hiddenTargets: 1 }));
    const rows = caption.rows.join('\n');
    expect(rows).toContain('not included (1)');
    expect(rows).toContain('took no part in this prediction');
    // and it is NOT re-projected onto the collapsed boundary: ringing `Data`
    // to mean "kill postgres" would assert the wrong experiment.
    expect(blastPlan(b, execIdx, { hiddenTargets: 1 }).targets).not.toContain('data');
  });

  it('says nothing of the sort when every target is drawn', () => {
    const b = blastRadiusMulti(doc, ['db', 'api']);
    const caption = blastCaption(b, blastPlan(b, openIdx));
    expect(caption.rows.join('\n')).not.toContain('not included');
    expect(blastPlan(b, openIdx).hiddenTargets).toBe(0);
  });

  it('drops a target from the rings when the view does not draw it', () => {
    // blastPlan's filter, on its own: a target that is not drawn gets no ring
    // and is NOT swapped for its collapsed ancestor.
    const b = blastRadiusMulti(doc, ['db', 'reporting']);
    const plan = blastPlan(b, execIdx);
    expect(b.targets).toEqual(['db', 'reporting']);
    expect(plan.targets).toEqual(['reporting']);
    expect(plan.targets).not.toContain('data');
  });

  it('degrades the channel that scales with the union, not the one that does not', () => {
    // §8.2: rings are capped at 8 and grow linearly; the at-risk edge accents
    // grow with the union and saturate the picture at about three targets.
    const two = blastRadiusMulti(doc, ['db', 'api']);
    const twoPlan = blastPlan(two, openIdx);
    expect(MAX_EDGE_ACCENT_TARGETS).toBe(2);
    expect(twoPlan.atRiskEdges.length).toBeGreaterThan(0);
    expect(twoPlan.atRiskEdgesSuppressed).toBe(0);

    const three = blastRadiusMulti(doc, ['db', 'api', 'orders']);
    const threePlan = blastPlan(three, openIdx);
    expect(threePlan.targets).toHaveLength(3);
    expect(threePlan.atRiskEdges).toEqual([]);
    expect(threePlan.atRiskEdgesSuppressed).toBeGreaterThan(0);
    // The tint still carries the whole set — nothing is hidden, only the
    // second channel saying the same thing — and the caption says so.
    expect(threePlan.atRisk.length).toBeGreaterThan(0);
    expect(blastCaption(three, threePlan).notes.join('\n')).toContain(
      'edge highlighting is off past 2 targets',
    );
  });
});

// --- 3c. an unresolved target never gets an asserted structural claim ------

describe('a target that resolved to nothing gets no articulation row', () => {
  const erd: GraphDoc = {
    schemaVersion: 1,
    title: 'Billing',
    direction: 'DOWN',
    groups: [],
    nodes: [
      { id: 'inv', label: 'Invoices', type: 'entity', parent: null },
      { id: 'svc', label: 'Billing', type: 'service', parent: null },
    ],
    edges: [],
    collapsed: [],
  };
  const erdIdx = buildDrawnIndex(erd, deriveViewDetail(erd, []));

  it('does not turn "not applicable" into an asserted "no" for an entity either', () => {
    // An entity is excluded from the runtime projection (A4), so no
    // articulation was ever computed for it — but articulationValue sees kind
    // 'entity' with a null articulation and falls through the group guard to
    // the asserted negative. Unreachable before click-to-target (the backlog
    // never offers an entity) and reachable now: toggleBlastTarget accepts any
    // drawn id, which is exactly the point of clicking.
    const b = blastRadiusMulti(erd, ['inv']);
    const caption = blastCaption(b, blastPlan(b, erdIdx));
    expect(b.per[0]?.targetKind).toBe('entity');
    expect(b.per[0]?.note).not.toBe(null);
    expect(caption.rows.join('\n')).not.toContain('articulation');
    // the honest note is still there, and still core's
    expect(caption.rows.join('\n')).toContain('not a runtime component');
  });

  it('still prints it for a target that genuinely resolved', () => {
    const b = blastRadiusMulti(erd, ['svc']);
    const caption = blastCaption(b, blastPlan(b, erdIdx));
    expect(caption.rows.join('\n')).toContain('articulation  no');
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
    const blast = blastRadiusMulti(doc, ['db']);
    const caption = blastCaption(blast, blastPlan(blast, openIdx));
    // Every assumption reaches the screen verbatim. The §18.11 caveat is
    // deliberately lifted out of the grey notes block into the rows (see the
    // §18.11 test below), so it is checked against both — printed exactly
    // once, unaltered, and never dropped on the way.
    for (const a of blast.assumptions) {
      expect([...caption.notes, ...caption.rows].filter((line) => line.includes(a))).toHaveLength(
        1,
      );
    }
    for (const a of blast.assumptions) {
      if (a !== blast.redundancyCaveat) expect(caption.notes).toContain(a);
    }
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
    const blast = blastRadiusMulti(doc, ['db']);
    const caption = blastCaption(blast, blastPlan(blast, openIdx));
    expect(caption.rows.join('\n')).toContain('contained (1)');
    expect(caption.rows.join('\n')).toContain('Reporting');
    expect(caption.headline).toBe('blast radius — Postgres');
  });

  it('says what is selected and that the number is a UNION (§18.7)', () => {
    const b = blastRadiusMulti(doc, ['db', 'api']);
    const caption = blastCaption(b, blastPlan(b, openIdx));
    const rows = caption.rows.join('\n');
    expect(caption.headline).toBe('blast radius — 2 targets combined');
    expect(rows).toContain('targets (2)  Postgres, API gateway');
    expect(rows).toContain('union');
    // The articulation row is NOT restated for a set: core deliberately has
    // no such field, and summing the per-target answers would be the caption
    // asserting a structural claim nothing computed (§15.2).
    expect(rows).not.toContain('articulation');
  });

  it('carries §18.11 verbatim: the union cannot see redundancy', () => {
    const b = blastRadiusMulti(doc, ['db', 'api']);
    const caption = blastCaption(b, blastPlan(b, openIdx));
    // core's sentence, printed not composed — the same route C2 and C3 take.
    expect(b.redundancyCaveat).toBe(ASSUMPTION_NO_REDUNDANCY);
    expect(caption.notes.join(' ')).toContain('"at risk" is not "will fail"');
    // It sits in the ROWS, immediately under the sentence it qualifies, and
    // in the rows' own weight. In the flat notes block it arrived fifth, in
    // grey, under two sentences that print on every single-target view — the
    // confident half of the claim dark, the qualifying half grey.
    const iUnion = caption.rows.findIndex((r) => r.includes('union'));
    const iCaveat = caption.rows.findIndex((r) =>
      r.includes(ASSUMPTION_NO_REDUNDANCY),
    );
    expect(iUnion).toBeGreaterThanOrEqual(0);
    expect(iCaveat).toBe(iUnion + 1);
    expect(caption.rows.join(' ')).toContain('replicas');
    // Verbatim in exactly ONE place: never rephrased, and never twice.
    expect(caption.notes).not.toContain(ASSUMPTION_NO_REDUNDANCY);
    // A SINGLE target gets it too, and this is a deliberate reversal of the
    // earlier contract. The over-report belongs to the document's untagged
    // edges, not to the union, so it is as true of one click as of five —
    // and while it was multi-only, the CLI printed a redundancy sentence on
    // every prediction while this surface, the one you can click, printed
    // none. Two surfaces making different honesty claims about one document
    // is the failure C3 exists to prevent. Still in the rows, still verbatim,
    // still exactly once.
    const one = blastRadiusMulti(doc, ['db']);
    const oneCaption = blastCaption(one, blastPlan(one, openIdx));
    expect(one.redundancyCaveat).toBe(ASSUMPTION_NO_REDUNDANCY);
    expect(oneCaption.rows.filter((r) => r.includes(ASSUMPTION_NO_REDUNDANCY))).toHaveLength(1);
    expect(oneCaption.notes).not.toContain(ASSUMPTION_NO_REDUNDANCY);
  });

  it('names what a live alternative held up — the §18.11 row (spared)', () => {
    // The surface §18.11 was written about: toggle off a replica and the
    // at-risk set shrinks. Without this row the reason is invisible, which is
    // also what a wrong answer looks like. Core's computation, the same one
    // the CLI prints, so the two cannot disagree about who was held up.
    const ha: GraphDoc = {
      schemaVersion: 1,
      title: 'HA',
      direction: 'DOWN',
      groups: [],
      nodes: [
        { id: 'app', label: 'App', type: 'service', parent: null },
        { id: 'pg-primary', label: 'Primary', type: 'database', parent: null },
        { id: 'pg-replica', label: 'Replica', type: 'database', parent: null },
      ],
      edges: [
        { id: 'e1', from: 'app', to: 'pg-primary', alt: 'db' },
        { id: 'e2', from: 'app', to: 'pg-replica', alt: 'db' },
      ],
      collapsed: [],
    };
    const idx = buildDrawnIndex(ha, deriveViewDetail(ha, []));
    const b = blastRadiusMulti(ha, ['pg-primary']);
    const rows = blastCaption(b, blastPlan(b, idx)).rows.join('\n');
    expect(rows).toContain('at risk (0)');
    expect(rows).toContain(
      'spared (1)  App (alt \u201cdb\u201d — lost pg-primary, still up: pg-replica)',
    );
    // and nothing of the sort on a document that states no redundancy
    const plain = blastRadiusMulti(doc, ['db']);
    expect(blastCaption(plain, blastPlan(plain, openIdx)).rows.join('\n')).not.toContain('spared');
  });

  it('captions an empty selection as empty, never as "nothing is at risk"', () => {
    const b = blastRadiusMulti(doc, []);
    const caption = blastCaption(b, blastPlan(b, openIdx));
    expect(caption.headline).toBe('blast radius — no target selected');
    expect(caption.rows.join('\n')).not.toContain('at risk (0)');
    // and the way out and back in is on the screen, not in a manual
    expect(caption.hint).toBe(HOW_TO_TARGET);
    expect(HOW_TO_TARGET).toContain('Esc');
  });

  it('teaches the gesture in every blast state, not only the unreachable one', () => {
    // The bug this pins: the hint used to render ONLY for an empty selection,
    // and entering the mode seeds the backlog top — so the one line that says
    // a box is clickable was visible only after you had already clicked one.
    for (const ids of [[], ['db'], ['db', 'api']]) {
      const b = blastRadiusMulti(doc, ids);
      expect(blastCaption(b, blastPlan(b, openIdx)).hint).toBe(HOW_TO_TARGET);
    }
    expect(HOW_TO_TARGET).toContain('shift-click');
    // The wording matches what a plain click actually does at n > 1: it
    // REPLACES the selection. "clicking again clears it" is true only of a
    // sole target, and saying it flatly invites throwing away a set of eight.
    expect(HOW_TO_TARGET).toContain('replaces the selection');
    expect(HOW_TO_TARGET).toContain('sole target');
  });

  it('says why a click did nothing once the cap is reached (§8.2)', () => {
    // A document with more killable components than the cap, so the row is
    // asserted rather than skipped.
    const wide: GraphDoc = {
      ...raw,
      groups: [],
      nodes: [
        { id: 'app', label: 'App', type: 'service', parent: null },
        ...Array.from({ length: MAX_BLAST_TARGETS }, (_, i) => ({
          id: `shard${i}`,
          label: `Shard ${i}`,
          type: 'database' as const,
          parent: null,
        })),
      ],
      edges: Array.from({ length: MAX_BLAST_TARGETS }, (_, i) => ({
        id: `w${i}`,
        from: 'app',
        to: `shard${i}`,
      })),
    };
    const idx = buildDrawnIndex(wide, deriveViewDetail(wide, []));
    const ids = Array.from({ length: MAX_BLAST_TARGETS }, (_, i) => `shard${i}`);
    const b = blastRadiusMulti(wide, ids);
    const plan = blastPlan(b, idx);
    expect(plan.targets).toHaveLength(MAX_BLAST_TARGETS);
    expect(blastCaption(b, plan).rows.join('\n')).toContain(
      `${MAX_BLAST_TARGETS} is the limit`,
    );
    // below the cap the panel stays quiet about it
    const few = blastRadiusMulti(doc, ['db', 'api']);
    expect(blastCaption(few, blastPlan(few, openIdx)).rows.join('\n')).not.toContain(
      'is the limit',
    );
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
      plan: blastPlan(blastRadiusMulti(doc, ['db']), openIdx),
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
    const blast = blastRadiusMulti(doc, ['db']);
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
    const single = blastRadius(doc, 'data');
    expect(single.targetKind).toBe('group');
    expect(single.articulation).toBeNull();
    const blast = blastRadiusMulti(doc, ['data']);
    const caption = blastCaption(blast, blastPlan(blast, execIdx));
    const rows = caption.rows.join('\n');
    expect(rows).not.toContain('articulation  no');
    // core's own sentence, the one the CLI prints
    expect(rows).toContain('a boundary is not a single point of failure');
  });

  it('still asserts "no" for a node that genuinely is not one', () => {
    const blast = blastRadiusMulti(doc, ['orders']);
    const caption = blastCaption(blast, blastPlan(blast, openIdx));
    expect(caption.rows.join('\n')).toContain('articulation  yes');
    const leaf = blastRadiusMulti(doc, ['reporting']);
    expect(
      blastCaption(leaf, blastPlan(leaf, openIdx)).rows.join('\n'),
    ).toContain('articulation  no — removing it does not split the diagram');
  });

  it('names what the experiment kills, as the CLI headline does', () => {
    const blast = blastRadiusMulti(doc, ['data']);
    const caption = blastCaption(blast, blastPlan(blast, execIdx));
    expect(caption.headline).toBe('blast radius — Data (boundary — kills 1 component)');
  });
});
