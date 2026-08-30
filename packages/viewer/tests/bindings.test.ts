// P5-03 — binding chips in the hover panel, each opening the referenced file
// (spec §3.8, §8.6; BUILD.md P5-03).
//
// The card is rendered to static markup, the way every other HoverCard test
// here does it, and the assertions are about two things and no others:
//
//   1. the chip carries the CHECKER'S OWN spelling of the binding, so the
//      string on screen, the string in the get-table's `### Bindings` section
//      and the string in a `diagram check --bindings` failure row are one
//      string a reader can match by eye;
//   2. a chip offers a link exactly when there is a file to open, and never
//      otherwise — an identifier names something inside a file, a malformed
//      ref should never have validated, and neither gets an affordance the
//      document cannot support.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GBinding, GNode } from '@diagram-engine/core';
import { HoverCard, cardHeight } from '../src/render/HoverCard.js';
import { bindingHref, editorSchemeFrom } from '../src/render/bindingLink.js';
import { parseServerMessage } from '../src/ws.js';

const ROOT = '/repo';

const node = (bindings?: GBinding[]): GNode => ({
  id: 'orders',
  label: 'Orders',
  type: 'service',
  parent: null,
  ...(bindings === undefined ? {} : { bindings }),
});

const card = (n: GNode, root: string | null = ROOT): string =>
  renderToStaticMarkup(
    createElement(HoverCard, { node: n, x: 10, y: 10, vw: 1200, vh: 800, root }),
  );

// ---------------------------------------------------------------------------
// bindingHref — the pure half
// ---------------------------------------------------------------------------

describe('bindingHref', () => {
  it('opens a file at its line', () => {
    expect(bindingHref({ source: 'repo', ref: 'internal/pay.go', line: 412 }, ROOT)).toBe(
      'vscode://file/repo/internal/pay.go:412',
    );
  });

  it('opens a file with no line, and a directory', () => {
    expect(bindingHref({ source: 'repo', ref: 'internal/pay.go' }, ROOT)).toBe(
      'vscode://file/repo/internal/pay.go',
    );
    expect(bindingHref({ source: 'repo', ref: 'services/orders/' }, ROOT)).toBe(
      'vscode://file/repo/services/orders',
    );
  });

  it('normalises the ref exactly as the checker does', () => {
    // Same parse, same module: "./a//b.go" is "a/b.go" to both.
    expect(bindingHref({ source: 'repo', ref: './internal//pay.go', line: 4 }, ROOT)).toBe(
      'vscode://file/repo/internal/pay.go:4',
    );
  });

  it('offers NO link for an identifier — there is no file to open', () => {
    expect(bindingHref({ source: 'terraform', ref: 'aws_ecs_service.orders' }, ROOT)).toBeNull();
    expect(bindingHref({ source: 'compose', ref: 'orders-api' }, ROOT)).toBeNull();
    expect(bindingHref({ source: 'package', ref: '@acme/utils' }, ROOT)).toBeNull();
  });

  it('offers NO link for a ref V16 would have rejected', () => {
    // A document carrying one was hand-edited past validation, and that is the
    // last document to hand a working link to.
    for (const ref of ['https://example.com/a.go', '/etc/passwd', '../../etc/passwd', '~/.ssh/id_rsa']) {
      expect(bindingHref({ source: 'repo', ref }, ROOT), ref).toBeNull();
    }
  });

  it('offers NO link when the viewer was told no root', () => {
    // A ref is repo-relative; with no root there is no file to name, and a
    // guess opens the wrong one.
    expect(bindingHref({ source: 'repo', ref: 'internal/pay.go' }, null)).toBeNull();
    expect(bindingHref({ source: 'repo', ref: 'internal/pay.go' }, '')).toBeNull();
  });

  it('encodes a path without destroying its separators', () => {
    expect(bindingHref({ source: 'repo', ref: 'my services/pay#1.go' }, ROOT)).toBe(
      'vscode://file/repo/my%20services/pay%231.go',
    );
  });

  it('speaks the other editor schemes', () => {
    const b: GBinding = { source: 'repo', ref: 'internal/pay.go', line: 412 };
    expect(bindingHref(b, ROOT, 'cursor')).toBe('cursor://file/repo/internal/pay.go:412');
    expect(bindingHref(b, ROOT, 'idea')).toBe(
      'idea://open?file=%2Frepo%2Finternal%2Fpay.go&line=412',
    );
    // file:// has nowhere to put a line, and does not pretend otherwise.
    expect(bindingHref(b, ROOT, 'file')).toBe('file:///repo/internal/pay.go');
  });

  it('reads ?editor= off the viewer URL, and ignores anything else', () => {
    expect(editorSchemeFrom('?editor=idea')).toBe('idea');
    expect(editorSchemeFrom('?editor=notepad')).toBe('vscode');
    expect(editorSchemeFrom('')).toBe('vscode');
  });
});

// ---------------------------------------------------------------------------
// The chips themselves
// ---------------------------------------------------------------------------

describe('binding chips in the hover panel', () => {
  it('renders one chip per binding, in the checker\'s spelling', () => {
    const html = card(
      node([
        { source: 'repo', ref: 'internal/pay.go', line: 412 },
        { source: 'terraform', ref: 'aws_ecs_service.orders' },
      ]),
    );
    expect(html).toContain('data-hover-bindings="2"');
    expect(html).toContain('data-binding="repo=internal/pay.go:412"');
    expect(html).toContain('data-binding="terraform=aws_ecs_service.orders"');
    expect(html).toContain('read from 2 sources');
  });

  it('makes the path chip a link to the right file, and the identifier chip not a link', () => {
    const html = card(
      node([
        { source: 'repo', ref: 'internal/pay.go', line: 412 },
        { source: 'terraform', ref: 'aws_ecs_service.orders' },
      ]),
    );
    expect(html).toContain('href="vscode://file/repo/internal/pay.go:412"');
    // One anchor, not two: the identifier is a span.
    expect(html.match(/<a /g) ?? []).toHaveLength(1);
    expect(html).toContain('nothing to open');
  });

  it('renders chips as text when no root is known', () => {
    const html = card(node([{ source: 'repo', ref: 'internal/pay.go', line: 412 }]), null);
    expect(html).toContain('data-binding="repo=internal/pay.go:412"');
    expect(html).not.toContain('<a ');
  });

  it('costs an uncited node NOTHING — no section, no word', () => {
    // The rule §4.1's optional table sections follow: a document that does not
    // use bindings must not pay for them.
    const html = card(node());
    expect(html).not.toContain('data-hover-bindings');
    expect(html).not.toContain('read from');
    expect(html).toBe(card(node([])));
  });

  it('counts the chips in the card height, so the flip math still fits', () => {
    expect(cardHeight(node([{ source: 'repo', ref: 'a.go' }]))).toBeGreaterThan(
      cardHeight(node()),
    );
  });

  it('takes the pointer on the chips row ONLY', () => {
    // §8.6: the card sets pointer-events:none on itself so it can never steal
    // the hover it describes. The chips row opts back in, because a link that
    // cannot be clicked is not a link.
    const html = card(node([{ source: 'repo', ref: 'internal/pay.go' }]));
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('pointer-events:auto');
  });
});

// ---------------------------------------------------------------------------
// The root arrives with the document
// ---------------------------------------------------------------------------

describe('the doc frame carries the project root', () => {
  const doc = { title: 't', direction: 'DOWN', nodes: [], groups: [], edges: [] };

  it('reads the root the server sent', () => {
    const frame = parseServerMessage(JSON.stringify({ type: 'doc', doc, root: '/repo' }));
    expect(frame).toMatchObject({ type: 'doc', root: '/repo' });
  });

  it('is null when the server sends none, so a chip is text rather than a guess', () => {
    // An older server, or one that could not resolve a root: the document
    // still paints, and no chip offers to open a file it cannot name.
    expect(parseServerMessage(JSON.stringify({ type: 'doc', doc }))).toMatchObject({
      type: 'doc',
      root: null,
    });
    expect(parseServerMessage(JSON.stringify({ type: 'doc', doc, root: 42 }))).toMatchObject({
      root: null,
    });
  });
});
