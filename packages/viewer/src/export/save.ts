// export/save.ts — saving the picture FROM THE BROWSER (spec Part 10 Step 16,
// §8.4's ⌘S). The CLI half of Step 16 is commands/export.ts; this is the other
// half, and it exists so that the three shipped strings pointing an agent at
// "the viewer's own 2× export" describe something that is actually there.
//
// ONE DEFINITION OF THE PICTURE, still. The SVG is not re-rendered and the
// document is not re-laid-out: the frame already on screen — the DERIVED
// document, its ELK geometry and the composed §6 paths — goes straight into
// renderSvgString, the same emitter `diagram export svg` uses headlessly. So
// what lands in the file is what the reader is looking at, collapse included,
// and there is no second serialiser to drift.
//
// PNG is that same SVG drawn onto a canvas at 2× and read back with toBlob.
// It is a BROWSER capability for a real reason (Node has no rasteriser and
// §1.6 forbids adding one on a whim), which is exactly why it lives here and
// why the CLI refuses png with a pointer to this control.
//
// §1.6: saving is a read of what is on screen. Nothing here mutates the
// document, writes to the socket, or touches .diagram/ — the browser hands
// the file to the user's own download, the way a screenshot would.
//
// The pure parts (the filename, the shortcut predicate, the pixel size) are
// separated from the four DOM calls so they can be tested in Node, which has
// no canvas, no Blob URL and no <a download>.

import type { GraphDoc } from '@diagram-engine/core';
import type { LaidOut } from '../layout/fromElk.js';
import { SVG_PADDING, renderSvgString } from './toSvg.js';

/** The factor §8.4/Step 16 asks for: a 2× raster, so the PNG survives zoom. */
export const PNG_SCALE = 2;

/** What one saved file is made of. `width`/`height` are CSS px, pre-scale. */
export interface SavableFrame {
  /** The standalone .svg document, byte-identical to the CLI's emitter. */
  svg: string;
  /** Intrinsic width in px, padding included. */
  width: number;
  /** Intrinsic height in px, padding included. */
  height: number;
  /** Suggested base filename, no extension. */
  name: string;
}

/**
 * `Checkout Platform!` -> `checkout-platform`. Lowercase-hyphenated for the
 * same reason ids are (rules.md rule 2), and never empty: a download named
 * `.svg` is a hidden file on macOS and Linux.
 */
export function fileSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'diagram' : slug;
}

/**
 * Serialise the frame on screen. Pure and synchronous — the layout and the
 * geometry already happened, so this cannot disagree with the picture.
 */
export function frameToSvg(
  doc: GraphDoc,
  laidOut: LaidOut,
  paths: string[],
  padding: number = SVG_PADDING,
): SavableFrame {
  return {
    svg: renderSvgString(doc, laidOut, paths, { padding }),
    width: laidOut.width + padding * 2,
    height: laidOut.height + padding * 2,
    name: fileSlug(doc.title),
  };
}

/**
 * True for the ⌘S / Ctrl-S the status strip advertises. Ignores the browser
 * repeat and anything typed into a field, so it cannot fire twice or steal a
 * keystroke meant for text. Pure, so the rule is testable without a DOM.
 */
export function isSaveShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  target?: unknown;
}): boolean {
  if (e.key.toLowerCase() !== 's') return false;
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  if (e.repeat === true) return false;
  const tag = (e.target as { tagName?: string } | undefined)?.tagName;
  return tag !== 'INPUT' && tag !== 'TEXTAREA';
}

// ---------------------------------------------------------------------------
// The DOM half
// ---------------------------------------------------------------------------

/**
 * A `data:` URL for the SVG. `encodeURIComponent` rather than btoa: labels
 * are arbitrary Unicode (a group called "München" is ordinary), and btoa
 * throws on anything outside Latin-1.
 */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Hand a file to the user's browser. An object URL plus a synthetic click on
 * an <a download> — the only way a page can save a file it generated — then
 * the URL is revoked so the blob is not held for the life of the tab.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save the frame as `<title>.svg`. */
export function saveSvg(frame: SavableFrame): void {
  downloadBlob(new Blob([frame.svg], { type: 'image/svg+xml;charset=utf-8' }), `${frame.name}.svg`);
}

/**
 * Rasterise the frame to a PNG at `scale`× and hand it over.
 *
 * The SVG is loaded as an <img> from a data: URL (not a blob: URL — Safari
 * has historically refused to decode SVG blob URLs into an image) and drawn
 * onto a canvas sized `width*scale × height*scale`. The canvas is painted
 * with the §8.2 paper colour first: renderSvgString's own background rect
 * covers the same area, but a PNG that is transparent where the diagram is
 * not is a surprise in a slide deck.
 *
 * Rejects rather than saving a blank file when the image cannot be decoded
 * or the canvas is unavailable, so a failure is visible instead of silent.
 */
export async function svgToPngBlob(
  frame: SavableFrame,
  scale: number = PNG_SCALE,
): Promise<Blob> {
  const img = new Image();
  img.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('the browser could not decode the diagram SVG'));
    img.src = svgDataUrl(frame.svg);
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('this browser has no 2d canvas to rasterise with');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.drawImage(img, 0, 0, frame.width, frame.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error('canvas produced no PNG')) : resolve(blob)),
      'image/png',
    );
  });
}

/** Save the frame as `<title>.png` at 2×. Throws what svgToPngBlob throws. */
export async function savePng(frame: SavableFrame, scale: number = PNG_SCALE): Promise<void> {
  downloadBlob(await svgToPngBlob(frame, scale), `${frame.name}.png`);
}
