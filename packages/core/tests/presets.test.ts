// tests/presets.test.ts — preset resolution (spec Part 7): which group ids end
// up in doc.collapsed for exec, eng and focus, and what happens when focus is
// pointed at something that is not a group.

import { describe, expect, it } from 'vitest';
import {
  isViewPresetName,
  parseViewPreset,
  resolvePreset,
  VIEW_PRESET_NAMES,
} from '../src/view/presets.js';
import { doc, group, node } from './helpers.js';

/**
 * A three-deep tree:
 *
 *   prod (root)            staging (root)
 *   └── vpc-private        └── vpc-stage
 *       └── db-subnet
 *           └── postgres (node)
 */
function nested() {
  return doc({
    groups: [
      group('prod', { kind: 'account' }),
      group('vpc-private', { kind: 'vpc', parent: 'prod' }),
      group('db-subnet', { parent: 'vpc-private' }),
      group('staging', { kind: 'account' }),
      group('vpc-stage', { kind: 'vpc', parent: 'staging' }),
    ],
    nodes: [node('postgres', { type: 'database', parent: 'db-subnet' })],
  });
}

describe('preset: eng', () => {
  it('collapses nothing', () => {
    const r = resolvePreset(nested(), { preset: 'eng' });
    expect(r).toEqual({ ok: true, collapsed: [] });
  });

  it('collapses nothing in an empty document either', () => {
    const r = resolvePreset(doc(), { preset: 'eng' });
    expect(r).toEqual({ ok: true, collapsed: [] });
  });
});

describe('preset: exec', () => {
  it('collapses the root-level groups only', () => {
    const r = resolvePreset(nested(), { preset: 'exec' });
    expect(r).toEqual({ ok: true, collapsed: ['prod', 'staging'] });
  });

  it('is empty when there are no groups at all', () => {
    const r = resolvePreset(doc({ nodes: [node('api')] }), { preset: 'exec' });
    expect(r).toEqual({ ok: true, collapsed: [] });
  });

  it('collapses every group when the tree is flat', () => {
    const flat = doc({ groups: [group('a'), group('b'), group('c')] });
    const r = resolvePreset(flat, { preset: 'exec' });
    expect(r).toEqual({ ok: true, collapsed: ['a', 'b', 'c'] });
  });
});

describe('preset: focus', () => {
  it('keeps the target and its ancestors open, collapses the rest', () => {
    const r = resolvePreset(nested(), { preset: 'focus', id: 'db-subnet' });
    // open: db-subnet, vpc-private, prod → collapsed: the staging half
    expect(r).toEqual({ ok: true, collapsed: ['staging', 'vpc-stage'] });
  });

  it('focusing a root group collapses every other group', () => {
    const r = resolvePreset(nested(), { preset: 'focus', id: 'prod' });
    expect(r).toEqual({ ok: true, collapsed: ['vpc-private', 'db-subnet', 'staging', 'vpc-stage'] });
  });

  it('focusing a leaf group leaves its own descendants (there are none) alone', () => {
    const r = resolvePreset(nested(), { preset: 'focus', id: 'vpc-stage' });
    expect(r).toEqual({ ok: true, collapsed: ['prod', 'vpc-private', 'db-subnet'] });
  });

  it('rejects an unknown id and lists the valid groups', () => {
    const r = resolvePreset(nested(), { preset: 'focus', id: 'vpc-privat' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('unknown focus group "vpc-privat"');
    expect(r.errors[0]).toContain('Existing groups: prod, vpc-private, db-subnet');
  });

  it('says so when the document has no groups to focus', () => {
    const r = resolvePreset(doc(), { preset: 'focus', id: 'anything' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('This diagram has no groups');
    expect(r.errors[0]).toContain('"eng"');
  });

  it('rejects a node id and points at the group holding it', () => {
    const r = resolvePreset(nested(), { preset: 'focus', id: 'postgres' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('focus target "postgres" is a node, not a group');
    expect(r.errors[0]).toContain('Did you mean its group "db-subnet"?');
  });

  it('rejects a top-level node with the "nothing to focus" wording', () => {
    const d = doc({ nodes: [node('api')], groups: [group('vpc-a', { kind: 'vpc' })] });
    const r = resolvePreset(d, { preset: 'focus', id: 'api' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('nothing to focus');
  });

  it('terminates on a cyclic parent chain instead of spinning', () => {
    // V4 rejects this document, but the resolver must not depend on that.
    const cyclic = doc({
      groups: [group('a', { parent: 'b' }), group('b', { parent: 'a' }), group('c')],
    });
    const r = resolvePreset(cyclic, { preset: 'focus', id: 'a' });
    expect(r).toEqual({ ok: true, collapsed: ['c'] });
  });
});

describe('parseViewPreset', () => {
  it('parses the two argument-free presets', () => {
    expect(parseViewPreset('exec')).toEqual({ ok: true, preset: { preset: 'exec' } });
    expect(parseViewPreset('eng')).toEqual({ ok: true, preset: { preset: 'eng' } });
  });

  it('parses focus with an id', () => {
    expect(parseViewPreset('focus', 'vpc-private')).toEqual({
      ok: true,
      preset: { preset: 'focus', id: 'vpc-private' },
    });
  });

  it('rejects focus with no id, saying what to type', () => {
    const r = parseViewPreset('focus');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('diagram view focus <group-id>');
  });

  it('rejects an unknown preset name and lists the three', () => {
    const r = parseViewPreset('boardroom');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toBe('unknown preset "boardroom": use one of exec, eng, focus');
  });

  it('isViewPresetName agrees with the exported list', () => {
    for (const name of VIEW_PRESET_NAMES) expect(isViewPresetName(name)).toBe(true);
    expect(isViewPresetName('focus ')).toBe(false);
  });
});
