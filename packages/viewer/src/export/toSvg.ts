// export/toSvg.ts — headless SVG export (spec Part 10 Step 16; rendering
// is Part 8, markers are §6.7/§8.5).
//
// exportSvg(doc) takes a stored document all the way to a standalone .svg
// STRING with no browser anywhere in the chain: derive the view (Part 7),
// size and lay out with the ordinary §5 pipeline, compose the §6 edge
// paths, then serialise the SAME React components the screen draws.
//
// ONE DEFINITION OF THE PICTURE. The layers come from render/Canvas.tsx's
// FrameLayers and the markers from render/EdgePath.tsx, rendered through
// react-dom/server. There is deliberately no second string emitter that
// "knows" how a node box looks: if there were, the exported file and the
// screen could drift, and nothing would catch it. What this module owns is
// only the chrome a <g> cannot carry — the root <svg> element, the
// namespace, the viewBox, the paper-coloured background, and a <style>
// resolving the font stacks for viewers outside a browser.
//
// Canvas.tsx itself is NOT used: it is stateful (cross-fade timers,
// useLayoutEffect) and injects a CSS @keyframes animation, so a file
// exported from it would fade in when opened. FrameLayers is the pure,
// stateless half of that component and is what Canvas renders internally —
// same markup, no clock.
//
// THE TEXT MEASUREMENT PROBLEM. §5.1 sizing measures labels with a cached
// offscreen canvas, and there is no canvas in Node. layout/measure.ts
// already answers that with a deterministic per-character estimate, and
// this module hardens the contract around it: assertTextMeasurement()
// proves the live measurement path separates different strings and never
// answers zero, because a measurement stuck at 0 does not throw — it
// produces a laid-out diagram of overlapping minimum-width boxes that
// looks like it worked.
//
// Pure and async only because ELK is. No DOM, no network, no geometry ever
// written back to the document (§1.4/§3.1).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GraphDoc } from '@diagram-engine/core';
// Runtime import of the core SOURCE module rather than the barrel: the
// barrel re-exports store/ (node:fs), which must not be dragged into the
// browser bundle. debug/fixtures.ts takes the same route for the same
// reason.
import { deriveView } from '../../../core/src/view/derive.js';
import { composeFramePaths } from '../geometry/index.js';
import type { LaidOut } from '../layout/fromElk.js';
import {
  EDGE_LABEL_FONT,
  ENTITY_FIELD_FONT,
  LABEL_FONT,
  estimateTextWidth,
  measureText,
} from '../layout/measure.js';
import { layout, type ElkEngine } from '../layout/runLayout.js';
import { FrameLayers } from '../render/Canvas.js';
import {
  ArrowMarker,
  CrowManyMarker,
  CrowOneMarker,
  ReturnMarker,
} from '../render/EdgePath.js';
import { theme } from '../render/theme.js';

/** Whitespace left around the laid-out content, px. */
export const SVG_PADDING = 24;

/**
 * Font declarations carried in the exported file's <defs>.
 *
 * The components draw with the `font` shorthands from measure.ts, which
 * name `system-ui` and `ui-monospace` — families a browser resolves and
 * almost nothing else does. Those shorthands are INLINE styles, so a
 * plain `text{font-family:...}` rule could not override them anyway; what
 * works is the `@font-face ... src: local(...)` pair below, which teaches
 * the renderer what `system-ui` and `ui-monospace` actually ARE. The
 * `svg{}` rule is the belt to that braces, for a consumer that strips
 * inline styles. Nothing here changes what the components emit, so the
 * on-screen path is untouched.
 */
const SANS_STACK =
  'system-ui,-apple-system,"Helvetica Neue",Helvetica,Arial,' +
  '"Liberation Sans",sans-serif';
const MONO_STACK =
  'ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",' +
  '"Courier New",monospace';

export const SVG_FONT_CSS = [
  `svg{font-family:${SANS_STACK}}`,
  `text{font-family:${SANS_STACK}}`,
  `@font-face{font-family:system-ui;src:local("Helvetica Neue"),` +
    `local(Helvetica),local(Arial),local("Liberation Sans")}`,
  `@font-face{font-family:ui-monospace;src:local("SF Mono"),local(Menlo),` +
    `local("DejaVu Sans Mono"),local("Courier New")}`,
  `.de-mono{font-family:${MONO_STACK}}`,
].join('');

/** Thrown when the live text measurement path is unusable (see below). */
export class TextMeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextMeasurementError';
  }
}

/**
 * Prove that the measurement `sizeNode` is about to use actually measures.
 *
 * Two failures are possible and BOTH are silent: measurement pinned at
 * zero (a stubbed 2d context), and measurement that returns one constant
 * for every string (a shim that ignores its argument). Either lays the
 * document out without error into a heap of identical, overlapping boxes.
 * Better to refuse to export than to hand back a wrong picture, so this
 * runs before layout and throws.
 *
 * The probe strings differ in length AND in glyph class, so a correct
 * implementation cannot coincidentally give them equal widths.
 */
export function assertTextMeasurement(): void {
  const fonts = [LABEL_FONT, EDGE_LABEL_FONT, ENTITY_FIELD_FONT];
  for (const font of fonts) {
    const narrow = measureText('i', font);
    const wide = measureText('MMMMMMMMMM', font);
    if (!(narrow > 0) || !(wide > 0)) {
      throw new TextMeasurementError(
        `text measurement returned ${narrow}/${wide} px at "${font}" — ` +
          'labels would size to nothing and every box would overlap. ' +
          'Install a measurement strategy with setMeasureStrategy().',
      );
    }
    if (!(wide > narrow)) {
      throw new TextMeasurementError(
        `text measurement is constant at "${font}" (${narrow} px for both ` +
          '"i" and "MMMMMMMMMM") — labels are not being measured at all.',
      );
    }
  }
}

/** Options for the string emitter and the whole export. */
export interface SvgOptions {
  /** Whitespace around the content, px. Default SVG_PADDING (24). */
  padding?: number;
  /**
   * Paint the §8.2 canvas colour behind everything. Default true — a .svg
   * with no background is transparent, and this theme's text is nearly
   * black on near-white paper, so on a dark viewer it vanishes.
   */
  background?: boolean;
  /** Value for the root `<title>`. Default doc.title. */
  title?: string;
}

/** Options for the full document -> string export. */
export interface ExportSvgOptions extends SvgOptions {
  /** Collapsed group ids. Default: the document's own `collapsed`. */
  collapsed?: readonly string[];
  /** ELK engine override, as `layout()` takes. Default: the bundled build. */
  elk?: ElkEngine;
}

/** Escape a string for use as XML text content. */
function xmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Format a viewBox coordinate: at most 2 decimals, no "-0". */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r === 0 ? 0 : r);
}

/**
 * Serialise ONE already-laid-out frame to a standalone SVG document
 * string. Synchronous and pure: everything ELK-shaped has already
 * happened, so this is the half that tests can drive with hand-written
 * geometry.
 *
 * Structure, in paint order:
 *   <svg> -> <title> -> <defs>(markers + font CSS) -> background rect ->
 *   <g> holding FrameLayers, i.e. the §8.1 layers 1-6 verbatim.
 *
 * The hover layer (7) is never emitted: it is a live-pointer affordance
 * and means nothing in a file.
 */
export function renderSvgString(
  doc: GraphDoc,
  laidOut: LaidOut,
  paths: string[],
  options: SvgOptions = {},
): string {
  const pad = options.padding ?? SVG_PADDING;
  const w = laidOut.width + pad * 2;
  const h = laidOut.height + pad * 2;
  const title = options.title ?? doc.title;

  // The markers come from the very components the canvas puts in its own
  // <defs>, so an exported arrowhead cannot differ from a drawn one.
  const defs = [
    renderToStaticMarkup(createElement(ArrowMarker)),
    // §3.9's open return head. Absent from the <defs> an edge that references
    // it renders with NO head at that end and no error anywhere — the export
    // would silently drop the half of the picture that says a call answers.
    renderToStaticMarkup(createElement(ReturnMarker)),
    renderToStaticMarkup(createElement(CrowOneMarker)),
    renderToStaticMarkup(createElement(CrowManyMarker)),
  ].join('');

  const layers = renderToStaticMarkup(
    createElement(FrameLayers, { doc, laidOut, paths }),
  );

  const background =
    options.background === false
      ? ''
      : `<rect data-layer="background" x="${fmt(-pad)}" y="${fmt(-pad)}" ` +
        `width="${fmt(w)}" height="${fmt(h)}" fill="${theme.canvas}"/>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" ` +
    `width="${fmt(w)}" height="${fmt(h)}" ` +
    `viewBox="${fmt(-pad)} ${fmt(-pad)} ${fmt(w)} ${fmt(h)}">` +
    `<title>${xmlText(title)}</title>` +
    `<defs>${defs}<style>${SVG_FONT_CSS}</style></defs>` +
    background +
    `<g data-frame="export">${layers}</g>` +
    `</svg>\n`
  );
}

/** Everything the export produced, for callers that want the numbers too. */
export interface SvgExport {
  /** The standalone .svg document. */
  svg: string;
  /** The view actually drawn — collapse applied (Part 7). */
  doc: GraphDoc;
  /** Its geometry. Viewer-side only; never persisted (§1.4). */
  laidOut: LaidOut;
  /** Composed edge paths, index-aligned with laidOut.edges. */
  paths: string[];
}

/**
 * Document -> standalone SVG string, headless. Runs the §7 collapse, the
 * §5 layout and the §6 geometry, then serialises.
 *
 * Throws TextMeasurementError when the environment cannot measure text at
 * all — see assertTextMeasurement.
 */
export async function exportSvgDetail(
  doc: GraphDoc,
  options: ExportSvgOptions = {},
): Promise<SvgExport> {
  assertTextMeasurement();
  // deriveView is idempotent, so this is the single call: the collapse
  // happens once, at the top of the export path.
  const view =
    options.collapsed === undefined
      ? deriveView(doc)
      : deriveView(doc, options.collapsed);
  const laidOut = await layout(view, options.elk);
  const rects = [...laidOut.nodes.values()];
  const paths = composeFramePaths(laidOut.edges, rects);
  return { svg: renderSvgString(view, laidOut, paths, options), doc: view, laidOut, paths };
}

/** Document -> standalone SVG string. The one-line form of the above. */
export async function exportSvg(
  doc: GraphDoc,
  options: ExportSvgOptions = {},
): Promise<string> {
  return (await exportSvgDetail(doc, options)).svg;
}

/**
 * The Node-side measurement strategy, offered for callers that want to
 * PIN measurement to the deterministic table rather than merely fall back
 * to it — a CLI that must emit byte-identical SVG on every machine, say.
 * The default export path does not install it: left alone, a browser
 * export measures with the real canvas and so matches the screen exactly.
 */
export function deterministicMeasureStrategy(
  label: string,
  font: string,
): number {
  return estimateTextWidth(label, font);
}
