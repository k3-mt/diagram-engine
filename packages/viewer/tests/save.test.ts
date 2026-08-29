// tests/save.test.ts — saving the picture FROM THE BROWSER (spec Part 10
// Step 16, §8.4's ⌘S). The other half of Step 16 lives in tests/svgExport.
//
// What can be tested in Node, and what cannot. There is no DOM here — no
// Blob, no URL.createObjectURL, no <a download>, no canvas — so the four DOM
// calls (downloadBlob, saveSvg, savePng, svgToPngBlob) are not exercised.
// export/save.ts is written so that everything DECIDED is decided in a pure
// function that is: the filename, the shortcut predicate, the data URL, and —
// the one that matters — that the saved bytes are the frame already on
// screen, serialised through the very emitter `diagram export svg` uses
// headlessly. If a second serialiser ever appears, this file fails.

import { describe, expect, it } from 'vitest';
import { GraphDocSchema, type GraphDoc } from '@diagram-engine/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveView } from '../../core/src/view/derive.js';
import { composeFramePaths } from '../src/geometry/index.js';
import { layout } from '../src/layout/runLayout.js';
import { SVG_PADDING, renderSvgString } from '../src/export/toSvg.js';
import {
  PNG_SCALE,
  fileSlug,
  frameToSvg,
  isSaveShortcut,
  svgDataUrl,
} from '../src/export/save.js';

function loadFixture(name: string): GraphDoc {
  const path = fileURLToPath(
    new URL(`../../../tests/fixtures/${name}.json`, import.meta.url),
  );
  return GraphDocSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const nested = loadFixture('nested-two-deep');

/** One laid-out frame, exactly as main.tsx builds it before painting. */
async function frame(doc: GraphDoc, collapsed?: string[]) {
  const view = collapsed === undefined ? deriveView(doc) : deriveView(doc, collapsed);
  const laidOut = await layout(view);
  const paths = composeFramePaths(laidOut.edges, [...laidOut.nodes.values()]);
  return { doc: view, laidOut, paths };
}

describe('the saved file IS the frame on screen', () => {
  it('serialises through the same emitter the CLI export uses', async () => {
    const f = await frame(nested);
    const saved = frameToSvg(f.doc, f.laidOut, f.paths);
    expect(saved.svg).toBe(renderSvgString(f.doc, f.laidOut, f.paths, { padding: SVG_PADDING }));
    expect(saved.svg.startsWith('<?xml')).toBe(true);
  });

  it('reports the intrinsic size the PNG is rasterised against', async () => {
    const f = await frame(nested);
    const saved = frameToSvg(f.doc, f.laidOut, f.paths);
    expect(saved.width).toBe(f.laidOut.width + SVG_PADDING * 2);
    expect(saved.height).toBe(f.laidOut.height + SVG_PADDING * 2);
    expect(saved.width).toBeGreaterThan(0);
    // The 2x raster Step 16 asks for.
    expect(PNG_SCALE).toBe(2);
    expect(Math.round(saved.width * PNG_SCALE)).toBe(Math.round(saved.width) * 2);
  });

  it('saves the COLLAPSED picture when a view is on screen', async () => {
    const group = nested.groups[0] as { id: string };
    const o = await frame(nested, []);
    const s = await frame(nested, [group.id]);
    const open = frameToSvg(o.doc, o.laidOut, o.paths);
    const shut = frameToSvg(s.doc, s.laidOut, s.paths);
    expect(shut.svg).not.toBe(open.svg);
    // The stand-in box is in the file; the group rect is not.
    expect(shut.svg).toContain(`data-node="${group.id}"`);
    expect(shut.svg).not.toContain(`data-group="${group.id}"`);
  });
});

describe('the suggested filename', () => {
  it('is the title, lowercase-hyphenated', () => {
    expect(fileSlug('Checkout Platform')).toBe('checkout-platform');
    expect(fileSlug('Payments / EU (v2)')).toBe('payments-eu-v2');
  });

  it('is never empty — a file called ".svg" is a hidden file', () => {
    expect(fileSlug('')).toBe('diagram');
    expect(fileSlug('—— ——')).toBe('diagram');
  });

  it('comes from the document being saved', async () => {
    const f = await frame({ ...nested, title: 'Order Flow' });
    expect(frameToSvg(f.doc, f.laidOut, f.paths).name).toBe('order-flow');
  });
});

describe('the ⌘S shortcut predicate', () => {
  const base = { key: 's', metaKey: false, ctrlKey: false, altKey: false };

  it('fires on ⌘S and on Ctrl-S', () => {
    expect(isSaveShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isSaveShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isSaveShortcut({ ...base, metaKey: true, key: 'S' })).toBe(true);
  });

  it('ignores a bare s, a modified one, and a key repeat', () => {
    expect(isSaveShortcut(base)).toBe(false);
    expect(isSaveShortcut({ ...base, key: 'a', metaKey: true })).toBe(false);
    expect(isSaveShortcut({ ...base, metaKey: true, altKey: true })).toBe(false);
    expect(isSaveShortcut({ ...base, metaKey: true, repeat: true })).toBe(false);
  });

  it('never steals a keystroke aimed at a text field', () => {
    for (const tagName of ['INPUT', 'TEXTAREA']) {
      expect(isSaveShortcut({ ...base, metaKey: true, target: { tagName } })).toBe(false);
    }
    expect(isSaveShortcut({ ...base, metaKey: true, target: { tagName: 'DIV' } })).toBe(true);
  });
});

describe('the data URL the rasteriser loads', () => {
  it('percent-encodes rather than base64 — labels are arbitrary Unicode', async () => {
    const f = await frame({ ...nested, title: 'München' });
    const url = svgDataUrl(frameToSvg(f.doc, f.laidOut, f.paths).svg);
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length))).toContain(
      'München',
    );
    // btoa() would have thrown on that string; this path must not use it.
    expect(url).not.toContain('base64');
  });

  it('encodes the characters that would otherwise end the URL', () => {
    const url = svgDataUrl('<svg><title>a#b&c</title></svg>');
    expect(url).not.toContain('#');
    expect(url).toContain('%23');
  });
});
