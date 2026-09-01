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
    //
    // P5-02 added rule 15 (bindings) and again found the room rather than
    // borrowing it. Three places, all of them text the agent was holding
    // twice or text that was not quite true:
    //   * "## Group kinds" — five bare words with no gloss, identical to the
    //     `kind` enum in diagram_patch's generated inputSchema. Rule 7 still
    //     says what a group MEANS.
    //   * the product lists on database/queue/cache/storage — the type NAMES
    //     survive as one line; kafka -> queue and redis -> cache are general
    //     knowledge, not this project's convention. The two glosses that ARE
    //     convention (service/external ownership, and client's examples) stay.
    //   * rule 11's second sentence, which said the errors "list the valid
    //     ids". Only the unknown-parent error does; the rest offer a single
    //     "Did you mean". An instruction resting on that is worth less than
    //     the room it takes.
    // The full table and the group kinds are still in rules.md, which
    // `diagram rules` prints and `diagram init` installs as the skill.
    //
    // §3.9 (edge kind) put a new vocabulary into rule 6 and one clause into
    // rule 4, and again found the room rather than borrowing it — from the
    // two rules the new vocabulary SUBSUMES, which is the only honest place
    // to take it from:
    //   * rule 6 was "DASHED for asynchronous relationships (queue
    //     consumption, events, webhooks). Solid for synchronous calls." Its
    //     whole content is now one consequence of `kind`, so the rule states
    //     the kinds and keeps the style fallback in five words.
    //   * rule 5's examples — "reads", "publishes", "grpc" — were three
    //     labels illustrating a verb the `kind` enum now supplies by name,
    //     in the same tool listing, from diagram_patch's generated schema.
    //     The rule keeps its instruction and drops the illustration.
    // `returns` and `seq` are deliberately NOT here: they reach the agent as
    // field names in that same generated inputSchema, and the full
    // vocabulary is in rules.md's addendum. Same argument as the group kinds
    // above.
    expect(compact.length).toBeLessThan(3000);
  });

  it('keeps the no-coordinates preamble and the element types', () => {
    expect(compact).toContain('NEVER produce coordinates');
    // Every one of the eight type names still reaches the agent...
    for (const type of ['service', 'database', 'queue', 'cache', 'storage', 'client', 'external'])
      expect(compact, type).toContain(type);
    // ...and the trimmed row is pinned AS A LINE. The loop above is a
    // substring match, and rule 6 supplies "queue" ("queue consumption") while
    // rule 10 supplies "cache" ("Remove the cache") — delete the row entirely
    // and two of its four names would still be found. This assertion is what
    // actually holds the cut in place.
    expect(compact).toContain('\ndatabase, queue, cache, storage\n');
    // ...and so do the two glosses that are this project's convention rather
    // than general knowledge: who owns a service, and what a client is.
    expect(compact).toContain('service an application the user owns and deploys');
    expect(compact).toContain('external a third-party system the user does not control');
    expect(compact).toContain('client browser app, mobile app, cli');
  });

  it('leaves the group-kind list to the generated schema', () => {
    // Deliberate, not an accident of trimming: the same five words ship as the
    // `kind` enum in diagram_patch's inputSchema, in the same tool listing as
    // this text. They stay in the canonical file for a human reader.
    expect(compact).not.toContain('vpc, region, cluster, account, generic');
    expect(loadRules()).toContain('vpc, region, cluster, account, generic');
  });

  it('keeps the headline of every numbered rule, and no others', () => {
    // The rule NUMBERS present, as a set — not a loop to a hard-coded upper
    // bound, which is how rule 14 arrived unpinned while this test still
    // looped to 12 and passed. The 13 gap is deliberate and now permanent:
    // 13 was reserved for bindings while they were unbuilt, and bindings
    // arrived as rule 15 (spec §3.8), so the gap stays rather than
    // renumbering rules the M8 benchmark was tuned against.
    const numbers = compact
      .split('\n')
      .map((line) => /^(\d+)\. /.exec(line)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15]);
    expect(compact).toContain('READ THE DIAGRAM FIRST');
    expect(compact).toContain('DO NOT INVENT');
    // Rule 9's edge-level prohibition. Rule 8 is entirely about BOXES ("a
    // mention is not a component"), so this sentence is the only thing in the
    // compact text telling the agent not to draw an edge it did not find —
    // and edge invention is what the M8 precision metric measures. It was cut
    // once to save 28 characters; this pins it.
    expect(compact).toContain('Do not guess at connections.');
    // §18.11's rule 14, and the asymmetry the spec says must stay in the text:
    // over-reporting is survivable, a guessed alternative hides a real single
    // point of failure. Nothing asserted this before, so the next trim against
    // the cap could have dropped the rule this milestone added.
    expect(compact).toContain('14. REDUNDANCY IS TOLD, NEVER DEDUCED.');
    expect(compact).toContain('hides a real single point of failure');
    // Rule 15 (spec §3.8), and specifically the SANCTION. An agent told merely
    // to cite will cite; an agent told the citation is mechanically resolved
    // has a reason to cite only what it read, and the benchmark measured the
    // difference (the planted hidden edge was cited to its source file in 2 of
    // 20 runs under rule 9 alone). Pinning the headline alone would let the
    // half that does the work be trimmed against the cap.
    expect(compact).toContain('15. CITE WHAT YOU OPENED, NOTHING ELSE.');
    // §3.9's rule 6, and the half that does the work. Naming the five kinds
    // is what makes the field usable at all — the agent cannot pick a value
    // it has not been shown — and "INSTEAD of style and arrow" is the half
    // V20 rejects patches over, so an agent without it earns a rejection on
    // its first attempt. Pinned, or the next trim against the cap takes the
    // list and leaves the headline.
    expect(compact).toContain('call, read, write, publish, consume');
    expect(compact).toContain('INSTEAD of style and arrow');
    // Rule 4's clause. The arrow points at the DEPENDENCY and `kind` carries
    // the data direction; without this sentence the obvious reading of a new
    // `read` kind is to flip the edge, which would reverse every failure
    // prediction `analyse` makes.
    expect(compact).toContain('`kind` says so and the arrow does not');
    expect(compact).toContain('`diagram check --bindings` resolves every one');
    expect(compact).toContain('an invented citation does not survive the next commit');
    // Rule 9 names the mechanism. Until P5-01 there was nowhere on a GEdge to
    // put a citation, so the rule asked for something the schema could not
    // hold; the word `bindings` is what closes that.
    expect(compact).toContain('cite in `bindings` the file each node and edge came from');
    // The preamble line dropped by COMPACT_SKIP_LINES really is dropped —
    // asserted, not left to fail incidentally on the character budget.
    expect(compact).not.toContain('You edit a structured diagram document');
  });

  it('keeps every rule whole, unwrapped onto one line', () => {
    // Rule 1 is wrapped across four lines in the markdown; a half-quoted rule
    // would read as a mangled instruction, so it must survive intact.
    expect(compact).toContain(
      '1. READ THE DIAGRAM FIRST if you are not sure of the current state. Reuse existing ids.',
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
