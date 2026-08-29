// tests/svgExport.test.ts — headless SVG export (spec Part 10 Step 16;
// rendering §8, markers §6.7/§8.5).
//
// Two halves, and the FIRST is the one that matters most.
//
// 1. Text measurement. §5.1 sizes boxes by measuring labels on an offscreen
//    canvas, and Node has no canvas. If that path quietly answered 0 — or
//    one constant for every string — nothing would throw: ELK would lay the
//    document out into a heap of identical minimum-width boxes and the
//    export would "succeed". So these tests assert the live Node path
//    separates different strings and never returns zero, and that
//    assertTextMeasurement() actually catches both failures when they are
//    injected through the measurement strategy.
//
// 2. The exported document. Well-formed XML, the SVG namespace, the three
//    markers in <defs>, the §8.1 z-order preserved, one <path> per edge —
//    and, crucially, geometry IDENTICAL to what runLayout + composeFramePaths
//    produce for the same document, because the export must be the same
//    picture as the screen, not a second opinion about it.
//
// XML well-formedness is checked with the small hand-rolled scanner at the
// bottom: Node has no DOMParser and this repo adds no dependencies.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphDocSchema, type GraphDoc } from '@diagram-engine/core';
import { deriveView } from '../../core/src/view/derive.js';
import { composeFramePaths } from '../src/geometry/index.js';
import {
  EDGE_LABEL_FONT,
  ENTITY_FIELD_FONT,
  LABEL_FONT,
  estimateTextWidth,
  measureText,
  setMeasureStrategy,
  sizeNode,
} from '../src/layout/measure.js';
import { layout } from '../src/layout/runLayout.js';
import {
  SVG_PADDING,
  TextMeasurementError,
  assertTextMeasurement,
  deterministicMeasureStrategy,
  exportSvg,
  exportSvgDetail,
  renderSvgString,
} from '../src/export/toSvg.js';
import { theme } from '../src/render/theme.js';
import {
  ARROW_MARKER_ID,
  MANY_MARKER_ID,
  ONE_MARKER_ID,
} from '../src/render/EdgePath.js';

// --- fixtures --------------------------------------------------------------

function loadFixture(name: string): GraphDoc {
  const path = fileURLToPath(
    new URL(`../../../tests/fixtures/${name}.json`, import.meta.url),
  );
  return GraphDocSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const nested = loadFixture('nested-two-deep');
const erd = loadFixture('erd-ecommerce');

// Every test that installs a strategy must put measurement back, or the
// whole suite after it measures through the stub.
afterEach(() => setMeasureStrategy(null));

// ---------------------------------------------------------------------------
// 1. Text measurement — the silent-failure guard.
// ---------------------------------------------------------------------------

describe('Node text measurement never degrades to zero or a constant', () => {
  const strings = ['i', 'API Gateway', 'orders', 'MMMMMMMMMM', 'x'];

  it('returns a strictly positive width for every non-empty string', () => {
    for (const font of [LABEL_FONT, EDGE_LABEL_FONT, ENTITY_FIELD_FONT]) {
      for (const s of strings) {
        expect(measureText(s, font), `${s} @ ${font}`).toBeGreaterThan(0);
        expect(estimateTextWidth(s, font), `${s} @ ${font}`).toBeGreaterThan(0);
      }
    }
  });

  it('gives DIFFERENT widths to different strings (not one constant)', () => {
    const widths = strings.map((s) => measureText(s, LABEL_FONT));
    expect(new Set(widths).size).toBe(strings.length);
    // And the ordering is sane: ten Ms are wider than one i.
    expect(measureText('MMMMMMMMMM', LABEL_FONT)).toBeGreaterThan(
      measureText('i', LABEL_FONT),
    );
  });

  it('grows monotonically as a string is extended', () => {
    let previous = 0;
    for (let n = 1; n <= 12; n++) {
      const w = measureText('a'.repeat(n), LABEL_FONT);
      expect(w).toBeGreaterThan(previous);
      previous = w;
    }
  });

  it('scales with the font size rather than ignoring it', () => {
    const big = estimateTextWidth('orders', LABEL_FONT); // 14px
    const small = estimateTextWidth('orders', EDGE_LABEL_FONT); // 11px
    expect(small).toBeLessThan(big);
    expect(small / big).toBeCloseTo(11 / 14, 5);
  });

  it('actually varies the sizes ELK receives, per node', () => {
    // The end-to-end consequence: if measurement were constant, every box
    // would clamp to the same width and this set would have one member.
    const widths = new Set(
      nested.nodes.map((n) => sizeNode({ ...n, note: undefined }).width),
    );
    expect(widths.size).toBeGreaterThan(1);
  });
});

describe('measurement strategy injection', () => {
  it('takes over measurement, then restores exactly', () => {
    const before = measureText('Auth Service', LABEL_FONT);
    setMeasureStrategy(() => 42);
    expect(measureText('Auth Service', LABEL_FONT)).toBe(42);
    expect(measureText('anything else', LABEL_FONT)).toBe(42);
    setMeasureStrategy(null);
    expect(measureText('Auth Service', LABEL_FONT)).toBe(before);
  });

  it('clears the cache on install, so no stale width survives', () => {
    measureText('cached', LABEL_FONT);
    setMeasureStrategy(() => 7);
    expect(measureText('cached', LABEL_FONT)).toBe(7);
  });

  it('the deterministic strategy is the estimate, verbatim', () => {
    for (const s of ['api', 'Orders Service', 'created_at']) {
      expect(deterministicMeasureStrategy(s, LABEL_FONT)).toBe(
        estimateTextWidth(s, LABEL_FONT),
      );
    }
  });
});

describe('assertTextMeasurement', () => {
  it('passes on the real Node path', () => {
    expect(() => assertTextMeasurement()).not.toThrow();
  });

  it('THROWS when measurement is pinned at zero', () => {
    setMeasureStrategy(() => 0);
    expect(() => assertTextMeasurement()).toThrow(TextMeasurementError);
    expect(() => assertTextMeasurement()).toThrow(/would size to nothing/);
  });

  it('THROWS when measurement is a constant that ignores the string', () => {
    setMeasureStrategy(() => 33);
    expect(() => assertTextMeasurement()).toThrow(TextMeasurementError);
    expect(() => assertTextMeasurement()).toThrow(/constant/);
  });

  it('stops the export rather than emitting an overlapping diagram', async () => {
    setMeasureStrategy(() => 0);
    await expect(exportSvg(nested)).rejects.toBeInstanceOf(TextMeasurementError);
  });
});

// ---------------------------------------------------------------------------
// 2. The exported document.
// ---------------------------------------------------------------------------

describe('exportSvg produces a standalone SVG document', () => {
  it('is well-formed XML with the SVG namespace and a viewBox', async () => {
    const svg = await exportSvg(nested);
    expect(() => assertWellFormed(svg)).not.toThrow();
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/viewBox="-24 -24 [\d.]+ [\d.]+"/);
    expect(svg).toMatch(/<svg [^>]*width="[\d.]+" height="[\d.]+"/);
    expect(svg).toContain(`<title>${nested.title}</title>`);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('declares the arrowhead and both crow’s-foot markers in <defs>', async () => {
    const svg = await exportSvg(nested);
    const defs = svg.slice(svg.indexOf('<defs>'), svg.indexOf('</defs>'));
    expect(defs).toContain(`<marker id="${ARROW_MARKER_ID}"`);
    expect(defs).toContain(`<marker id="${ONE_MARKER_ID}"`);
    expect(defs).toContain(`<marker id="${MANY_MARKER_ID}"`);
    // §6.7: one marker serves both ends.
    expect(defs).toContain('orient="auto-start-reverse"');
  });

  it('declares fonts so it opens correctly outside a browser', async () => {
    const svg = await exportSvg(nested);
    expect(svg).toContain('@font-face{font-family:system-ui');
    expect(svg).toContain('@font-face{font-family:ui-monospace');
    expect(svg).toContain('Helvetica');
  });

  it('paints the §8.2 canvas colour behind everything, and can be told not to', async () => {
    const svg = await exportSvg(nested);
    expect(svg).toContain(`data-layer="background"`);
    expect(svg).toContain(`fill="${theme.canvas}"`);
    const bare = await exportSvg(nested, { background: false });
    expect(bare).not.toContain('data-layer="background"');
  });

  it('carries every node label as text', async () => {
    const svg = await exportSvg(nested);
    for (const n of nested.nodes) expect(svg).toContain(`>${n.label}<`);
    for (const g of nested.groups) expect(svg).toContain(`>${g.label}<`);
  });

  it('draws exactly one <path> per laid-out edge', async () => {
    const { svg, laidOut } = await exportSvgDetail(nested);
    const drawn = [...svg.matchAll(/data-layer="edge-path"/g)];
    expect(drawn.length).toBe(laidOut.edges.length);
    expect(drawn.length).toBe(nested.edges.length);
  });

  it('preserves the §8.1 z-order', async () => {
    const svg = await exportSvg(nested);
    const at = (layer: string): number => {
      const i = svg.indexOf(`<g data-layer="${layer}">`);
      expect(i, layer).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('groups'),
      at('group-labels'),
      at('edges'),
      at('edge-labels'),
      at('nodes'),
      at('node-content'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Background is painted before all of them; no hover layer in a file.
    expect(svg.indexOf('data-layer="background"')).toBeLessThan(order[0]!);
    expect(svg).not.toContain('data-layer="hover"');
  });

  it('honours the padding option in both the viewBox and the size', async () => {
    const { svg, laidOut } = await exportSvgDetail(nested, { padding: 0 });
    expect(svg).toContain(
      `viewBox="0 0 ${round2(laidOut.width)} ${round2(laidOut.height)}"`,
    );
    const padded = await exportSvg(nested);
    expect(padded).toContain(`viewBox="${-SVG_PADDING} ${-SVG_PADDING}`);
  });
});

describe('the exported geometry IS the pipeline geometry', () => {
  it('matches runLayout + composeFramePaths path-for-path', async () => {
    // Recompute the whole picture independently of the exporter.
    const view = deriveView(nested);
    const laidOut = await layout(view);
    const paths = composeFramePaths(laidOut.edges, [...laidOut.nodes.values()]);

    const svg = await exportSvg(nested);
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) {
      expect(d).not.toBe('');
      expect(svg).toContain(`d="${d}"`);
    }
  });

  it('places every node box at the rect ELK produced', async () => {
    const { svg, laidOut, doc } = await exportSvgDetail(nested);
    for (const n of doc.nodes) {
      const rect = laidOut.nodes.get(n.id);
      expect(rect, n.id).toBeDefined();
      const box = groupFor(svg, `<g data-node="${n.id}"`);
      expect(box, n.id).toContain(`x="${rect!.x}"`);
      expect(box, n.id).toContain(`y="${rect!.y}"`);
      expect(box, n.id).toContain(`width="${rect!.width}"`);
      expect(box, n.id).toContain(`height="${rect!.height}"`);
    }
  });

  it('is deterministic: the same document exports byte-identically', async () => {
    const a = await exportSvg(nested);
    const b = await exportSvg(nested);
    expect(a).toBe(b);
  });

  it('renderSvgString alone reproduces what the async export emitted', async () => {
    const { svg, doc, laidOut, paths } = await exportSvgDetail(nested);
    expect(renderSvgString(doc, laidOut, paths)).toBe(svg);
  });
});

describe('collapse (Part 7) is applied before layout', () => {
  it('draws the collapsed group as one box and drops its insides', async () => {
    const collapsed = await exportSvgDetail(nested, {
      collapsed: ['vpc-private'],
    });
    const full = await exportSvgDetail(nested);
    expect(collapsed.doc.nodes.length).toBeLessThan(full.doc.nodes.length);
    // The stand-in carries the group's label; its members are gone.
    expect(collapsed.svg).toContain('>Private VPC<');
    expect(collapsed.svg).not.toContain('>Orders Service<');
    expect(collapsed.svg).not.toContain('data-group="vpc-private"');
    expect(() => assertWellFormed(collapsed.svg)).not.toThrow();
  });

  it('defaults to the document’s own collapsed list', async () => {
    const stored: GraphDoc = { ...nested, collapsed: ['vpc-private'] };
    const fromDoc = await exportSvg(stored);
    const explicit = await exportSvg(nested, { collapsed: ['vpc-private'] });
    // Same picture; only the <title> could differ, and it does not here.
    expect(fromDoc).toBe(explicit);
  });
});

describe('ERD documents export too', () => {
  it('uses the crow’s-foot markers instead of arrowheads', async () => {
    const svg = await exportSvg(erd);
    expect(() => assertWellFormed(svg)).not.toThrow();
    const body = svg.slice(svg.indexOf('</defs>'));
    expect(body).toMatch(
      new RegExp(`marker-(start|end)="url\\(#(${ONE_MARKER_ID}|${MANY_MARKER_ID})\\)"`),
    );
    // Field rows are drawn in the monospace field font.
    expect(svg).toContain('ui-monospace');
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function round2(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r === 0 ? 0 : r);
}

/** The markup of the <g> that starts at `needle`, up to its first </g>. */
function groupFor(svg: string, needle: string): string {
  const start = svg.indexOf(needle);
  expect(start, needle).toBeGreaterThan(-1);
  const end = svg.indexOf('</g>', start);
  expect(end, needle).toBeGreaterThan(-1);
  return svg.slice(start, end);
}

/**
 * Minimal XML well-formedness check: tags balance, attributes are quoted,
 * and no raw `<` appears in text. Node ships no DOMParser and this repo
 * adds no dependencies, so this is the scanner. It is strict about the
 * things a broken emitter actually gets wrong.
 */
function assertWellFormed(xml: string): void {
  let i = 0;
  const stack: string[] = [];
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (xml.slice(i).includes('>')) return; // trailing text is fine
      break;
    }
    if (xml.slice(i, lt).includes('<')) throw new Error('raw < in text');
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const close = xml.indexOf('>', lt);
      if (close < 0) throw new Error('unterminated declaration');
      i = close + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    const raw = xml.slice(lt + 1, gt);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open ?? 'nothing'}>`);
      i = gt + 1;
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(body);
    if (!m) throw new Error(`bad tag <${raw}>`);
    const attrs = m[2] ?? '';
    if (attrs.trim() !== '' && !/^(\s+[A-Za-z_][\w:.-]*="[^"]*")+\s*$/.test(attrs)) {
      throw new Error(`unquoted or malformed attributes in <${m[1]}>: ${attrs}`);
    }
    if (!selfClosing) stack.push(m[1]!);
    // <style> content is CSS, not markup: skip to its closing tag.
    if (m[1] === 'style' && !selfClosing) {
      const close = xml.indexOf('</style>', gt);
      if (close < 0) throw new Error('unterminated <style>');
      stack.pop();
      i = close + '</style>'.length;
      continue;
    }
    i = gt + 1;
  }
  if (stack.length > 0) throw new Error(`unclosed: ${stack.join(', ')}`);
}

/** Index of the `>` that ends the tag opened at `lt`, skipping quotes. */
function findTagEnd(xml: string, lt: number): number {
  let inQuote = false;
  for (let j = lt + 1; j < xml.length; j++) {
    const c = xml[j];
    if (c === '"') inQuote = !inQuote;
    else if (c === '>' && !inQuote) return j;
  }
  throw new Error('unterminated tag');
}
