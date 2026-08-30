// render/bindingLink.ts — from a binding to a link that opens the file (P5-03).
//
// BUILD.md Phase 5: a binding "is a string in the document and, in the viewer,
// a link that opens that file". This is the whole of that: a pure function
// from a GBinding plus a project root to an href, or to null when there is
// nothing to open.
//
// It parses the ref with `parseBindingRef` from packages/core/src/bindings/ref.ts
// — the SAME pure module the get-table's `### Bindings` section, V16 and
// `diagram check --bindings` use, imported by path so the viewer does not pull
// node:fs in. That reuse is the point: a chip must never offer to open
// something the checker would refuse to resolve, and a second implementation
// of "is this a path" here would eventually disagree with the one that grades
// the document.
//
// Three things get NO link, and each is a claim the viewer would otherwise be
// making on no evidence:
//
//   * an identifier (`terraform=aws_ecs_service.orders`) — it names something
//     inside a file, and there is no file to open. The chip renders, plainly,
//     as what it is.
//   * a malformed ref (a URL, an absolute path, a `..`) — V16 rejects all of
//     them on every write path, so one can only be here because the document
//     was hand-edited past validation, and that is the last document to hand a
//     working link to.
//   * anything at all when the viewer has not been told the project root. A
//     ref is repo-relative; without a root there is no file to name, and a
//     guess would open the wrong one.
//
// Nothing here says whether the file EXISTS. That is the checker's job and it
// needs a filesystem; the viewer offers to open what the document cites, and
// `diagram check --bindings` is what says whether the citation is honest.

import type { GBinding } from '@diagram-engine/core';
import { parseBindingRef } from '../../../core/src/bindings/ref.js';

/**
 * Which URL scheme the chip should use. The default is the one registered by
 * the editor most of this project's users have open; the others exist so a
 * viewer served on a machine without it is not stuck with a dead link.
 *
 * `file` cannot carry a line number — that is the browser's limitation, not
 * an omission here.
 */
export type EditorScheme = 'vscode' | 'cursor' | 'idea' | 'file';

export const EDITOR_SCHEMES: readonly EditorScheme[] = ['vscode', 'cursor', 'idea', 'file'];

/** `?editor=idea` on the viewer URL, or the default. Never throws. */
export function editorSchemeFrom(search: string): EditorScheme {
  const value = new URLSearchParams(search).get('editor');
  return (EDITOR_SCHEMES as readonly string[]).includes(value ?? '')
    ? (value as EditorScheme)
    : 'vscode';
}

/**
 * Percent-encode a path for a URL while KEEPING the separators: a space or a
 * "#" in a filename must not truncate the href, and `/` must survive as a
 * separator or the editor gets one long filename.
 */
function encodePath(absolute: string): string {
  return absolute
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * The href for one binding, or null when there is nothing to open.
 *
 * `root` is the project root the refs are relative to — the same root
 * `diagram check --bindings` resolves against, which is why `diagram serve`
 * sends it rather than the viewer inventing one.
 */
export function bindingHref(
  binding: GBinding,
  root: string | null,
  editor: EditorScheme = 'vscode',
): string | null {
  if (root === null || root === '') return null;
  const parsed = parseBindingRef(binding.ref, binding.source);
  if (!parsed.ok || parsed.kind !== 'path') return null;

  // Posix join. The root arrives from the server as an absolute path; a
  // Windows one is left alone beyond the separator swap, which is all the
  // editor schemes need.
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const absolute = `${base}/${parsed.segments.join('/')}`;
  const line = binding.line;

  switch (editor) {
    case 'idea':
      return `idea://open?file=${encodeURIComponent(absolute)}${
        line === undefined ? '' : `&line=${line}`
      }`;
    case 'file':
      // No line: file:// has nowhere to put one.
      return `file://${encodePath(absolute)}`;
    case 'cursor':
    case 'vscode':
      return `${editor}://file${encodePath(absolute)}${line === undefined ? '' : `:${line}`}`;
  }
}
