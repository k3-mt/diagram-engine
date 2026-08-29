// tests/rules.test.ts — the rules text loads, stays in sync with the canonical
// markdown, and keeps working when the .md files are not on disk (spec §4.4).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compactRules, loadErdRules, loadRules, loadRulesFor } from '../src/rules/load.js';

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOAD_TS = path.join(CORE_ROOT, 'src', 'rules', 'load.ts');

describe('loadRules / loadErdRules', () => {
  it('returns packages/core/rules.md byte for byte', () => {
    const onDisk = fs.readFileSync(path.join(CORE_ROOT, 'rules.md'), 'utf8');
    expect(loadRules()).toBe(onDisk);
  });

  it('returns packages/core/rules-erd.md byte for byte', () => {
    const onDisk = fs.readFileSync(path.join(CORE_ROOT, 'rules-erd.md'), 'utf8');
    expect(loadErdRules()).toBe(onDisk);
  });

  it('loadRulesFor selects the variant', () => {
    expect(loadRulesFor('core')).toBe(loadRules());
    expect(loadRulesFor('erd')).toBe(loadErdRules());
  });

  it('the two documents are distinct', () => {
    expect(loadRules()).not.toBe(loadErdRules());
    expect(loadErdRules()).toContain('rules for ERD diagrams');
  });
});

describe('build safety — the rules survive being compiled into dist/', () => {
  // The CLI build compiles this module to packages/cli/dist/core/src/rules/
  // and copies no .md, so anything that located rules.md at runtime would be
  // green here and broken for an installed user. These two tests fail if the
  // module ever grows a filesystem dependency.

  it('load.ts reads no file at runtime', () => {
    // Comment lines are stripped first: the file's own header discusses the
    // filesystem approach it deliberately does not use.
    const code = fs
      .readFileSync(LOAD_TS, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('node:fs');
    expect(code).not.toContain('import.meta');
    expect(code).not.toContain('readFileSync');
  });

  it('loads from a copy of the module with no rules.md anywhere above it', async () => {
    // Stand the module up in a temp tree — no rules.md beside it, none in any
    // ancestor directory — exactly the shape of the built output.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-rules-'));
    try {
      const copied = path.join(tmp, 'load.ts');
      fs.copyFileSync(LOAD_TS, copied);
      const mod = (await import(/* @vite-ignore */ copied)) as {
        loadRules: () => string;
        compactRules: () => string;
      };
      expect(mod.loadRules()).toBe(loadRules());
      expect(mod.compactRules()).toBe(compactRules());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('compactRules', () => {
  const compact = compactRules();

  it('is much shorter than the full text', () => {
    expect(compact.length).toBeLessThan(loadRules().length);
    // Small enough to sit in an MCP tool description on every turn.
    // The cap has been 3000 since M6 and has NOT been raised. Rule 4's rewrite
    // (the dependency convention plus the read-it-as-a-sentence check) grew the
    // text, and the room for it was found rather than borrowed: rules.md's
    // "## Patch shape" section is excluded from the compact form
    // (COMPACT_SKIP_SECTIONS in rules/load.ts)
    // because diagram_patch already ships that shape as a generated JSON
    // Schema in the same tool listing, so restating it in prose charges the
    // agent twice for one fact. This text is paid for on every turn: do not
    // raise this number — find the room, or leave the text out.
    expect(compact.length).toBeLessThan(3000);
  });

  it('keeps the no-coordinates preamble and the element types', () => {
    expect(compact).toContain('NEVER produce coordinates');
    expect(compact).toContain('service');
    expect(compact).toContain('external');
    expect(compact).toContain('vpc, region, cluster, account, generic');
  });

  it('keeps the headline of all twelve numbered rules', () => {
    for (let n = 1; n <= 12; n += 1) {
      expect(compact).toContain(`\n${n}. `);
    }
    expect(compact).toContain('CALL diagram_get FIRST');
    expect(compact).toContain('DO NOT INVENT');
  });

  it('keeps every rule whole, unwrapped onto one line', () => {
    // Rule 1 is wrapped across four lines in the markdown; a half-quoted rule
    // would read as a mangled instruction, so it must survive intact.
    expect(compact).toContain(
      '1. CALL diagram_get FIRST if you are not sure of the current state. Reuse existing ids.',
    );
    for (const rule of compact.split('\n')) {
      if (/^\d+\. /.test(rule)) expect(rule.endsWith('.')).toBe(true);
    }
  });

  it('drops the markdown scaffolding and the addendum', () => {
    expect(compact).not.toContain('# Diagram engine');
    expect(compact).not.toContain('## ');
    expect(compact).not.toContain('Addendum');
    expect(compact).not.toContain('Node metadata');
  });

  it('points at ERD mode in one line rather than inlining it', () => {
    expect(compact).toContain('diagram rules --erd');
    expect(compact).not.toContain('FOREIGN KEYS ARE MARKED');
  });

  it('is stable across calls (memoised)', () => {
    expect(compactRules()).toBe(compact);
  });
});
