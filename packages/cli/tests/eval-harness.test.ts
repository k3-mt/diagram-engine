// tests/eval-harness.test.ts — the M8 measurement rig (BUILD.md P3-05 / P3-06,
// spec Part 10 M8, acceptance G9 / G12 / G13).
//
// Two things are under test, and the second one matters more than the first.
//
//  1. THE SCORER. It must give gold a perfect score against itself, and it must
//     detect each of the three real, observed failures the rig was built for:
//     reversed edge direction, invented infrastructure, and a coupling visible
//     only in code. A scorer that is quietly too generous inflates every number
//     in M8 and nothing downstream would notice.
//
//  2. THE ANTI-LEAK GUARANTEE. The answer key lives INSIDE the reference system
//     (fixtures/ref-a/gold.json sits beside docker-compose.yml). An eval that
//     shows the model its answer key measures nothing, so the staging pass
//     withholds the answer key and a second, independent audit pass proves the
//     staged tree carries none of it. The tests below fail if gold ever becomes
//     reachable from the workspace the agent runs in.
//
// Everything here runs against OS temp directories and reads the repository
// read-only. Nothing starts a reference system (ground rule R2) and nothing
// writes into the repo's .diagram/.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EVAL = path.join(REPO, 'scripts', 'eval');
const load = (f: string) => import(pathToFileURL(path.join(EVAL, f)).href) as Promise<any>;

let scorer: any;
let stager: any;
let aggregator: any;
let cfg: any;

beforeAll(async () => {
  scorer = await load('score.mjs');
  stager = await load('stage.mjs');
  aggregator = await load('aggregate.mjs');
  cfg = scorer.loadConfig();
});

const goldPath = (s: string) => path.join(REPO, 'fixtures', `ref-${s}`, 'gold.json');
const readGoldDoc = (s: string) => JSON.parse(fs.readFileSync(goldPath(s), 'utf8'));
const scoreDoc = (doc: any, s: string) => scorer.score(doc, scorer.loadGold(goldPath(s), s, cfg), s, cfg);

const tmps: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-harness-test-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. the scorer agrees with gold about gold
// ---------------------------------------------------------------------------

describe('scorer — gold against itself', () => {
  for (const sys of ['a', 'b']) {
    it(`system ${sys}: every number is perfect and both planted checks pass`, () => {
      const r = scoreDoc(readGoldDoc(sys), sys);
      expect(r.nodes.precision).toBe(1);
      expect(r.nodes.recall).toBe(1);
      expect(r.edges.precision).toBe(1);
      expect(r.edges.recall).toBe(1);
      expect(r.direction.accuracy).toBe(1);
      expect(r.invention.count).toBe(0);
      expect(r.invention.plantedAbsenceDrawn).toBe(false);
      expect(r.hiddenEdge.found).toBe(true);
      expect(r.hiddenEdge.directionCorrect).toBe(true);
      expect(r.types.accuracy).toBe(1);
    });
  }

  it('refuses to score when two gold nodes normalise to the same form', () => {
    // The matcher cannot tell such a pair apart, and silently picking one is how
    // a rig starts lying. See failure mode 1 in score.mjs.
    const doc = readGoldDoc('a');
    doc.nodes.push({ ...doc.nodes[3], id: 'orders-service', label: 'Orders service' });
    const p = path.join(tmpdir(), 'gold.json');
    fs.writeFileSync(p, JSON.stringify(doc));
    expect(() => scorer.loadGold(p, 'a', cfg)).toThrow(/normalise to the same form/);
  });
});

// ---------------------------------------------------------------------------
// 2. node matching — ids differ, meaning does not
// ---------------------------------------------------------------------------

describe('scorer — node matching rule', () => {
  it('matches on meaning, not on the literal id', () => {
    const doc = readGoldDoc('a');
    const rename = (from: string, to: string) => {
      for (const n of doc.nodes) if (n.id === from) n.id = to;
      for (const e of doc.edges) {
        if (e.from === from) e.from = to;
        if (e.to === from) e.to = to;
      }
    };
    rename('orders', 'orders-service'); // stopword — exact tier
    rename('postgres', 'sparrow-db'); //   alias table
    rename('fulfilment-worker', 'fulfillment-worker'); // spelling, alias table
    rename('api-gateway', 'gateway'); //   alias table

    const r = scoreDoc(doc, 'a');
    expect(r.nodes.recall).toBe(1);
    expect(r.nodes.precision).toBe(1);
    expect(r.edges.recall).toBe(1);
    expect(r.direction.accuracy).toBe(1);
    expect(r.invention.count).toBe(0);
  });

  it('is one-to-one: five spellings of one node cannot farm recall', () => {
    const doc = readGoldDoc('a');
    for (const id of ['auth-service', 'authentication', 'auth-api', 'identity']) {
      doc.nodes.push({ id, label: id, type: 'service', parent: null });
    }
    const r = scoreDoc(doc, 'a');
    expect(r.nodes.matched).toBe(8); // still eight gold nodes matched, not twelve
    expect(r.nodes.recall).toBe(1);
    expect(r.nodes.precision).toBeLessThan(1); // and the extras cost precision
    expect(r.invention.count).toBe(4);
  });

  it('a documented accepted variant is neither a hit nor a miss', () => {
    // gold-citations.md (system A): "an agent that adds a client node in front
    // of web has not invented infrastructure ... neither a hit nor a miss".
    const doc = readGoldDoc('a');
    doc.nodes.push({ id: 'browser', label: 'Browser', type: 'client', parent: null });
    const r = scoreDoc(doc, 'a');
    expect(r.nodes.neutral.map((n: any) => n.id)).toEqual(['browser']);
    expect(r.nodes.precision).toBe(1);
    expect(r.invention.count).toBe(0);
  });

  it('a wrong node type is reported without being laundered into an invention', () => {
    // gold-citations.md (system B) accepted-variant 5: typing vehicle-state as a
    // cache is explicitly NOT acceptable. It is still the same component, so it
    // must score as a type error, not as an invented cache.
    const doc = readGoldDoc('b');
    for (const n of doc.nodes) if (n.id === 'vehicle-state') n.type = 'cache';
    const r = scoreDoc(doc, 'b');
    expect(r.nodes.recall).toBe(1);
    expect(r.invention.count).toBe(0);
    expect(r.types.errors).toEqual([
      { node: 'vehicle-state', gold: 'database', produced: 'cache', as: 'vehicle-state' },
    ]);
  });

  it('an accepted type ambiguity costs nothing', () => {
    // gold-citations.md (system A): web is legitimately client OR service.
    const doc = readGoldDoc('a');
    for (const n of doc.nodes) if (n.id === 'web') n.type = 'service';
    expect(scoreDoc(doc, 'a').types.accuracy).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. the three real failures the rig exists to detect
// ---------------------------------------------------------------------------

describe('scorer — reversed edge direction (acceptance G9)', () => {
  it('scores direction as its own number: a perfect edge set with reversed arrows', () => {
    // The observed failure: a real document built under a self-contradictory
    // rule 4 had EIGHT of seventeen labelled edges pointing the wrong way. An
    // edge-set score that ignores direction calls that document perfect.
    const doc = readGoldDoc('b');
    let flipped = 0;
    for (const e of doc.edges) {
      if (flipped < 8) {
        [e.from, e.to] = [e.to, e.from];
        flipped += 1;
      }
    }
    const r = scoreDoc(doc, 'b');
    expect(r.edges.precision).toBe(1); // the edge set is untouched...
    expect(r.edges.recall).toBe(1);
    expect(r.direction.accuracy).toBeLessThan(0.95); // ...and direction catches it
    expect(r.direction.correct).toBe(r.direction.scored - 8);
    expect(r.direction.reversed).toHaveLength(8);
  });

  it('the queue direction trap: kafka -> worker is a direction failure, not a missing edge', () => {
    // README.md draws orders -> kafka -> fulfilment-worker, which is message
    // flow. Rule 4 wants the arrow on the dependency: worker -> kafka.
    const doc = readGoldDoc('a');
    const e = doc.edges.find((x: any) => x.id === 'fulfilment-worker-to-kafka');
    [e.from, e.to] = [e.to, e.from];
    const r = scoreDoc(doc, 'a');
    expect(r.edges.recall).toBe(1);
    expect(r.direction.accuracy).toBe(Number((11 / 12).toFixed(4)));
    expect(r.direction.reversed[0].gold).toBe('fulfilment-worker -> kafka');
  });

  it('an undirected arrow is not the gold direction', () => {
    const doc = readGoldDoc('a');
    doc.edges[0].arrow = 'both';
    const r = scoreDoc(doc, 'a');
    expect(r.direction.nonForwardArrows).toBe(1);
    expect(r.direction.accuracy).toBeLessThan(1);
  });

  it('splitting one gold edge into two does not cost precision, and both must point right', () => {
    // gold-citations.md: an agent splitting api-gateway -> auth into "proxies"
    // and "introspects" has found the same coupling, not an extra one.
    const doc = readGoldDoc('a');
    doc.edges.push({ id: 'api-gateway-introspects-auth', from: 'api-gateway', to: 'auth', label: 'introspects', style: 'solid', arrow: 'forward' });
    expect(scoreDoc(doc, 'a').edges.precision).toBe(1);
    expect(scoreDoc(doc, 'a').direction.accuracy).toBe(1);

    doc.edges[doc.edges.length - 1].from = 'auth';
    doc.edges[doc.edges.length - 1].to = 'api-gateway';
    expect(scoreDoc(doc, 'a').direction.accuracy).toBeLessThan(1);
  });
});

describe('scorer — invented infrastructure (acceptance G13)', () => {
  it('system A: the planted load balancer is flagged as the planted absence', () => {
    const doc = readGoldDoc('a');
    doc.nodes.push({ id: 'edge-lb', label: 'Edge load balancer', type: 'service', parent: null });
    doc.edges.push({ id: 'edge-lb-to-web', from: 'edge-lb', to: 'web', style: 'solid', arrow: 'forward' });
    const r = scoreDoc(doc, 'a');
    expect(r.invention.plantedAbsenceDrawn).toBe(true);
    expect(r.invention.plantedAbsence.drawn).toEqual(['edge-lb']);
    expect(r.invention.nodes[0].trap).toMatch(/load balancer/);
    // the edge hanging off it is unresolvable, not a second, separate failure
    expect(r.edges.precision).toBe(1);
    expect(r.edges.unresolvable).toHaveLength(1);
    expect(r.edges.precisionStrict).toBeLessThan(1);
  });

  it('system B: the position cache is flagged as the planted absence', () => {
    const doc = readGoldDoc('b');
    doc.nodes.push({ id: 'position-cache', label: 'Position cache', type: 'cache', parent: null });
    const r = scoreDoc(doc, 'b');
    expect(r.invention.plantedAbsenceDrawn).toBe(true);
    expect(r.invention.plantedAbsence.drawn).toEqual(['position-cache']);
  });

  it('system A: an S3 node is an invention here, however plausible it sounds', () => {
    // The spec's own demo prose (Part 12) says the worker writes to S3. This
    // system has none: it writes fulfilments to Postgres.
    const doc = readGoldDoc('a');
    doc.nodes.push({ id: 'fulfilment-bucket', label: 'S3 bucket', type: 'storage', parent: null });
    const r = scoreDoc(doc, 'a');
    expect(r.invention.count).toBe(1);
    expect(r.invention.plantedAbsenceDrawn).toBe(false); // a different trap
    expect(r.invention.nodes[0].trap).toMatch(/object storage/);
  });

  it('a real node is never an invention, whatever words are in its label', () => {
    // `web` is nginx, and "nginx" is in the load-balancer trap pattern. Traps
    // are only ever applied to nodes that matched no gold node.
    const doc = readGoldDoc('a');
    for (const n of doc.nodes) if (n.id === 'web') n.label = 'nginx web bundle';
    const r = scoreDoc(doc, 'a');
    expect(r.invention.count).toBe(0);
  });

  it('system A: naming the web node "nginx" is a reading of the source, not an invention', () => {
    // README.md:13 says "React bundle served by nginx" and web/nginx.conf is
    // right there, so an agent following rule 9 may name the container after
    // what it runs. Before the alias existed this cost a miss, a false
    // positive, an unresolvable edge AND a false G13 failure — four penalties
    // on a diagram that was right. This is the test that would have caught it.
    const doc = readGoldDoc('a');
    for (const n of doc.nodes) if (n.id === 'web') { n.label = 'nginx'; n.id = 'nginx'; }
    for (const e of doc.edges) {
      if (e.from === 'web') e.from = 'nginx';
      if (e.to === 'web') e.to = 'nginx';
    }
    const r = scoreDoc(doc, 'a');
    expect(r.invention.plantedAbsenceDrawn).toBe(false);
    expect(r.invention.count).toBe(0);
    expect(r.nodes.precision).toBe(1);
    expect(r.nodes.recall).toBe(1);
    expect(r.edges.unresolvable).toEqual([]);
  });

  it('system A: a SECOND nginx node beside web is still the planted absence', () => {
    // The alias must not become a laundry chute. Matching is one-to-one: `web`
    // takes the exact match, the extra node falls through to the trap.
    const doc = readGoldDoc('a');
    doc.nodes.push({ id: 'nginx', label: 'nginx', type: 'service', parent: null });
    const r = scoreDoc(doc, 'a');
    expect(r.invention.plantedAbsenceDrawn).toBe(true);
    expect(r.invention.plantedAbsence.drawn).toEqual(['nginx']);
  });

  it('system B: the position cache named after the table it shadows still fails G13', () => {
    // THE HOLE THIS CLOSES. `cache` is a shared modifier word, so a produced
    // `vehicle-state-cache` used to match gold's `vehicle-state` at T1, and
    // invention traps only ever see UNMATCHED nodes — so the one plant the
    // held-out system exists to catch scored a clean sweep. "vehicle-state
    // cache" is exactly what an agent that believed the FLEET-812 trace would
    // call it: handlers.go:68-70 puts the cache TODO on the vehicle-state read
    // path. PLANTED.md:103-111 says this document must fail B.
    const doc = readGoldDoc('b');
    for (const n of doc.nodes) {
      if (n.id === 'vehicle-state') { n.id = 'vehicle-state-cache'; n.label = 'vehicle-state cache'; n.type = 'cache'; }
    }
    for (const e of doc.edges) {
      if (e.from === 'vehicle-state') e.from = 'vehicle-state-cache';
      if (e.to === 'vehicle-state') e.to = 'vehicle-state-cache';
    }
    const r = scoreDoc(doc, 'b');
    expect(r.invention.plantedAbsenceDrawn).toBe(true);
    expect(r.nodes.missing).toContain('vehicle-state');
  });

  it('system B: a cache-typed node fails G13 even when its NAME matches gold exactly', () => {
    // The name-independent half. gold-b has no cache of any kind, so the TYPE
    // alone is the trap and it is checked over every produced node, matched or
    // not. Without this, mistyping vehicle-state as a cache left type.accuracy
    // 0.9231 as the only trace — one node in thirteen, gating nothing.
    const doc = readGoldDoc('b');
    for (const n of doc.nodes) if (n.id === 'vehicle-state') n.type = 'cache';
    const r = scoreDoc(doc, 'b');
    expect(r.invention.plantedAbsenceDrawn).toBe(true);
    expect(r.invention.plantedAbsence.byForbiddenType.map((n: any) => n.id)).toEqual(['vehicle-state']);
    expect(r.types.accuracy).toBeLessThan(1);
  });

  it('system A has no forbidden type: its own gold contains a real cache', () => {
    // redis is type `cache` in gold-a. The type check must be per-system, or
    // system A would fail G13 against its own answer key.
    const r = scoreDoc(readGoldDoc('a'), 'a');
    expect(r.invention.plantedAbsenceDrawn).toBe(false);
    expect(r.invention.plantedAbsence.byForbiddenType).toEqual([]);
  });
});

describe('scorer — the planted hidden edge (acceptance G12)', () => {
  it('system A: reports it missing when the worker -> auth edge is dropped', () => {
    const doc = readGoldDoc('a');
    doc.edges = doc.edges.filter((e: any) => e.id !== 'fulfilment-worker-to-auth');
    const r = scoreDoc(doc, 'a');
    expect(r.hiddenEdge.found).toBe(false);
    expect(r.edges.recall).toBeLessThan(1);
    expect(r.edges.missing).toContain('fulfilment-worker -> auth');
  });

  it('system A: found but reversed is found-with-wrong-direction, not found', () => {
    const doc = readGoldDoc('a');
    const e = doc.edges.find((x: any) => x.id === 'fulfilment-worker-to-auth');
    [e.from, e.to] = [e.to, e.from];
    const r = scoreDoc(doc, 'a');
    expect(r.hiddenEdge.found).toBe(true);
    expect(r.hiddenEdge.directionCorrect).toBe(false);
  });

  it('system B: the code-only maintenance-forecast -> dispatch edge', () => {
    const doc = readGoldDoc('b');
    doc.edges = doc.edges.filter(
      (e: any) => !(e.from === 'maintenance-forecast' && e.to === 'dispatch'),
    );
    const r = scoreDoc(doc, 'b');
    expect(r.hiddenEdge.found).toBe(false);
    // drawing the discoverable half (fleet-api -> dispatch) does not rescue it
    expect(r.edges.matched).toBeGreaterThan(10);
  });

  it('reports whether the hidden edge was cited to the source it is visible in', () => {
    // Both answer keys say a "found" edge nobody can point at a source file for
    // is a lucky guess — system A even plants the near-miss (SERVICE_ACCOUNT_ID
    // in docker-compose.yml) that produces one. Schema v1 gives GEdge no note,
    // no meta and no binding, so this cannot be measured per edge; it is
    // document-level evidence, reported beside `found` and never gated on. Per
    // edge provenance arrives with GBinding (BUILD.md P5-01/P5-02).
    const doc = readGoldDoc('a');
    const bare = scoreDoc(doc, 'a');
    expect(bare.hiddenEdge.found).toBe(true);
    expect(bare.hiddenEdge.citation.citedInDocument).toBe(false);

    for (const n of doc.nodes) {
      if (n.id === 'fulfilment-worker') n.meta = { source: 'fulfilment-worker/src/auth-client.js:6' };
    }
    const cited = scoreDoc(doc, 'a');
    expect(cited.hiddenEdge.found).toBe(true);
    expect(cited.hiddenEdge.citation.citedInDocument).toBe(true);
    expect(cited.hiddenEdge.citation.where).toMatch(/auth-client\.js/);

    // a citation to the credential env vars in docker-compose.yml is the
    // documented lucky guess, and it does not count as evidence
    for (const n of doc.nodes) {
      if (n.id === 'fulfilment-worker') n.meta = { source: 'docker-compose.yml:86' };
    }
    expect(scoreDoc(doc, 'a').hiddenEdge.citation.citedInDocument).toBe(false);
  });

  it('a neutral edge is in neither denominator', () => {
    // gold-citations.md (system A): fulfilment-worker -> orders is real coupling
    // through the shared database — neither a miss if absent nor an invention.
    const doc = readGoldDoc('a');
    const base = scoreDoc(doc, 'a');
    doc.edges.push({ id: 'worker-shares-orders', from: 'fulfilment-worker', to: 'orders', label: 'shares tables', style: 'dashed', arrow: 'forward' });
    const r = scoreDoc(doc, 'a');
    expect(r.edges.precision).toBe(base.edges.precision);
    expect(r.edges.recall).toBe(base.edges.recall);
  });
});

describe('scorer — an empty document is a zero, not a crash', () => {
  it('scores a document the agent never wrote to', () => {
    const empty = { schemaVersion: 1, title: 'Untitled', direction: 'RIGHT', nodes: [], groups: [], edges: [], collapsed: [] };
    const r = scoreDoc(empty, 'a');
    expect(r.nodes.recall).toBe(0);
    expect(r.nodes.precision).toBeNull(); // no denominator, and 0/0 is not 1
    expect(r.edges.recall).toBe(0);
    expect(r.direction.accuracy).toBeNull();
    expect(r.hiddenEdge.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. THE ANTI-LEAK GUARANTEE
// ---------------------------------------------------------------------------

describe('harness — the agent can never reach gold', () => {
  for (const sys of ['a', 'b']) {
    it(`staging ref-${sys} withholds every answer-key file and audits clean`, () => {
      const dest = path.join(tmpdir(), 'system');
      const { copied, skipped } = stager.stageAndAudit(path.join(REPO, 'fixtures', `ref-${sys}`), dest);
      expect(copied.length).toBeGreaterThan(20);
      const withheld = skipped.map((s: any) => s.path);
      expect(withheld).toContain('gold.json');
      expect(withheld).toContain('gold-citations.md');
      expect(withheld).toContain('PLANTED.md');
      // and, independently of what stage() believes, nothing is on disk
      expect(stager.walk(dest).filter((f: string) => stager.isDenied(path.basename(f)))).toEqual([]);
      expect(stager.audit(dest)).toEqual([]);
    });
  }

  // THE TEST THAT FAILS IF GOLD BECOMES REACHABLE. Three ways it could:
  // the file itself, a quotation of it, or a link back into the repository.

  it('fails when gold.json is present in the staged tree', () => {
    const dest = path.join(tmpdir(), 'system');
    stager.stageAndAudit(path.join(REPO, 'fixtures', 'ref-a'), dest);
    expect(stager.audit(dest)).toEqual([]);
    fs.copyFileSync(goldPath('a'), path.join(dest, 'gold.json'));
    expect(stager.audit(dest)).toEqual(['gold.json: answer-key file present in the agent\'s workspace']);
  });

  it('fails when gold.json is hidden deeper in the tree under any name', () => {
    const dest = path.join(tmpdir(), 'system');
    stager.stageAndAudit(path.join(REPO, 'fixtures', 'ref-a'), dest);
    fs.mkdirSync(path.join(dest, 'ops', 'notes'), { recursive: true });
    fs.copyFileSync(goldPath('a'), path.join(dest, 'ops', 'notes', 'gold.backup.json'));
    expect(stager.audit(dest).join('\n')).toMatch(/ops.notes.gold\.backup\.json: answer-key file/);
  });

  it('fails when a staged file merely quotes the answer key', () => {
    const dest = path.join(tmpdir(), 'system');
    stager.stageAndAudit(path.join(REPO, 'fixtures', 'ref-a'), dest);
    fs.appendFileSync(path.join(dest, 'README.md'), '\nSee PLANTED.md for the two plants.\n');
    expect(stager.audit(dest).join('\n')).toMatch(/README\.md: contains the leak marker/);
  });

  it('fails on a symlink, which is the one way a staged tree points back at the repo', () => {
    const dest = path.join(tmpdir(), 'system');
    stager.stageAndAudit(path.join(REPO, 'fixtures', 'ref-a'), dest);
    fs.symlinkSync(path.join(REPO, 'fixtures', 'ref-a'), path.join(dest, 'upstream'));
    expect(stager.audit(dest).join('\n')).toMatch(/upstream: symlink in the staged tree/);
    // and stage() would never have created one in the first place
    const second = path.join(tmpdir(), 'again');
    const { skipped } = stager.stage(dest, second);
    expect(skipped.map((s: any) => s.why)).toContain('symlink');
  });

  it('the fixed prompt names no gold file, no fixture path and no plant', () => {
    const prompt = fs.readFileSync(path.join(EVAL, 'prompt.txt'), 'utf8');
    for (const marker of [...stager.LEAK_MARKERS, 'fixtures/', 'ref-a', 'ref-b', 'load balancer', 'cache', 'auth-client', 'dispatch']) {
      expect(prompt.toLowerCase()).not.toContain(marker.toLowerCase());
    }
    // one substitution, and it is a path inside the agent's own workspace
    expect(prompt.match(/\{\{[A-Z_]+\}\}/g)).toEqual(['{{SYSTEM_DIR}}']);
  });

  it('the prompt is identical for both systems, and carries no per-system hint', () => {
    // The prompt is a variable we are not measuring. One template, one
    // substitution, and the substituted value is "./system" in both cases.
    const prompt = fs.readFileSync(path.join(EVAL, 'prompt.txt'), 'utf8');
    const a = prompt.replace('{{SYSTEM_DIR}}', './system');
    const b = prompt.replace('{{SYSTEM_DIR}}', './system');
    expect(a).toBe(b);
    expect(a).not.toMatch(/\{\{/);
  });

  it('eval.sh passes no gold path to the agent, and reads gold only after it exits', () => {
    const sh = fs.readFileSync(path.join(REPO, 'scripts', 'eval.sh'), 'utf8');
    // $GOLD appears only on the scoring and preflight lines, never inside the
    // subshell that runs the agent.
    const agentBlock = sh
      .slice(sh.indexOf('# 6. run the agent'), sh.indexOf('# 7. the produced document'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('#')) // comments explain; code is what runs
      .join('\n');
    expect(agentBlock).not.toContain('GOLD');
    expect(agentBlock).not.toContain('$REF');
    expect(agentBlock).not.toContain('fixtures');
    // the default agent gets no shell and no fetch, so nothing outside cwd is
    // reachable even by an agent that goes looking
    expect(sh).toContain('--allowedTools "Read,Grep,Glob,mcp__diagram"');
    expect(sh).not.toMatch(/--add-dir/);
  });

  for (const sys of ['a', 'b']) {
    it(`no staged file in ref-${sys} tells the agent it is a fixture, or names this repository`, () => {
      // fixtures/ref-b/go.mod used to open with "Reference system B for the
      // diagram-engine eval rig (BUILD.md P3-03)", and it was copied verbatim
      // into the agent's cwd for every system-B run. Three disclosures in one
      // line: that it is being scored, the repository name (the search term
      // that finds the answer key), and the file describing the whole rig.
      // No LEAK_MARKER matched it, because the list was a fixed vocabulary.
      const dest = path.join(tmpdir(), 'system');
      stager.stageAndAudit(path.join(REPO, 'fixtures', `ref-${sys}`), dest);
      const forbidden = [...stager.LEAK_MARKERS, ...stager.FIXTURE_ONLY_MARKERS()];
      for (const rel of stager.walk(dest)) {
        const text = fs.readFileSync(path.join(dest, rel), 'utf8').toLowerCase();
        for (const m of forbidden) {
          expect(`${rel}: ${text.includes(m.toLowerCase()) ? `LEAKS "${m}"` : 'clean'}`).toBe(`${rel}: clean`);
        }
      }
    });
  }

  it('the repository name is a fixture-scope marker only, not a workspace one', () => {
    // `diagram init` writes <!-- diagram-engine:begin --> sentinels into the
    // workspace CLAUDE.md and .gitignore. Those are the product's own markers,
    // not a leak, so the repo-name check has to be scoped to the staged
    // fixture — otherwise the last gate before the agent starts fails on every
    // single run and someone deletes the gate.
    expect(stager.LEAK_MARKERS).not.toContain(path.basename(REPO));
    expect(stager.FIXTURE_ONLY_MARKERS()).toContain(path.basename(REPO));
  });

  it("system B's code-only coupling is not given away in prose", () => {
    // G12 on B is the held-out measurement of "a dependency visible only by
    // reading code". deploy/README.md used to say the nightly forecast job
    // calls HoldVehicle in plain English, so an agent could score it without
    // opening a single .go file. Nothing outside Go may connect the caller to
    // the call.
    // Proximity, not whole file: deploy/README.md may still say what
    // maintenance-forecast IS (a nightly ECS task), which is deployment fact.
    // What it must not do is put the caller next to the call.
    const WINDOW = 6;
    const dest = path.join(tmpdir(), 'system');
    stager.stageAndAudit(path.join(REPO, 'fixtures', 'ref-b'), dest);
    for (const rel of stager.walk(dest)) {
      if (rel.endsWith('.go')) continue;
      const lines = fs.readFileSync(path.join(dest, rel), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!/HoldVehicle/i.test(lines[i] ?? '')) continue;
        const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join('\n');
        const hit = /forecast|nightly|maintenance/i.exec(near);
        expect(`${rel}:${i + 1} ${hit ? `names the caller ("${hit[0]}")` : 'names no caller'}`).toBe(
          `${rel}:${i + 1} names no caller`,
        );
      }
    }
  });

  it('eval.sh confines the agent with the OS, and says so instead of claiming a flag does it', () => {
    const sh = fs.readFileSync(path.join(REPO, 'scripts', 'eval.sh'), 'utf8');
    // --allowedTools is a permission PRE-APPROVAL, not a jail: Read/Grep/Glob
    // take absolute paths, and Glob alone finds a file named PLANTED.md
    // anywhere without being told where to look. Proven live against this rig.
    expect(sh).toContain('sandbox-exec');
    expect(sh).toMatch(/deny file-read-data \(subpath "\$REPO"\)/);
    expect(sh).toMatch(/deny file-read-data \(subpath "\$HOME\/\.claude"\)/);
    expect(sh).toContain('--disallowedTools "Bash,WebFetch,WebSearch,Task"');
    // and it refuses rather than running unconfined by accident
    expect(sh).toMatch(/no filesystem sandbox available/);
    expect(sh).toMatch(/UNCONFINED=1/);
  });

  it('--score-only writes no file unless one is named, and no mode clobbers a result', () => {
    // --score-only is the cheap command run over and over while debugging the
    // scorer; the agent run is the expensive one. They shared a default output
    // path, so debugging the scorer ate the run it was debugging.
    const sh = fs.readFileSync(path.join(REPO, 'scripts', 'eval.sh'), 'utf8');
    const block = sh.slice(sh.indexOf('if [ -n "$SCORE_ONLY" ]'), sh.indexOf('# --- confinement'));
    expect(block).toMatch(/if \[ -z "\$OUT" \]/); // stdout when no --out
    expect(sh).toMatch(/refuse_clobber/);
    expect(sh).toMatch(/Refusing to overwrite the record of a previous run/);
  });

  it('the scoring config lives outside the fixtures and is never staged', () => {
    // config.json quotes the answer key freely; it must stay scorer-side.
    expect(fs.existsSync(path.join(EVAL, 'config.json'))).toBe(true);
    const dest = path.join(tmpdir(), 'system');
    stager.stageAndAudit(path.join(REPO, 'fixtures', 'ref-a'), dest);
    expect(stager.walk(dest)).not.toContain('config.json');
  });
});

// ---------------------------------------------------------------------------
// 4b. provenance — binding precision and coverage (P5-02, acceptance G10/G11)
// ---------------------------------------------------------------------------

describe('scorer — bindings (acceptance G10/G11)', () => {
  // A tiny tree standing in for the staged reference system. The scorer resolves
  // citations against the tree THE AGENT READ, so these tests build one rather
  // than pointing at fixtures/, which the agent never sees.
  function tree(): string {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'services', 'orders'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n  orders:\n');
    fs.writeFileSync(path.join(root, 'services', 'orders', 'main.go'), 'a\nb\nc\n');
    return root;
  }

  const doc = (nodes: any[], edges: any[] = []) => ({
    schemaVersion: 1,
    title: 'T',
    direction: 'RIGHT',
    nodes,
    groups: [],
    edges,
    collapsed: [],
  });

  it('precision is the fraction of citations that resolve, and it is not coverage', () => {
    const root = tree();
    const produced = doc(
      [
        { id: 'orders', type: 'service', label: 'Orders', parent: null, bindings: [{ source: 'repo', ref: 'services/orders/main.go', line: 2 }] },
        { id: 'ghost', type: 'service', label: 'Ghost', parent: null, bindings: [{ source: 'repo', ref: 'services/ghost/main.go' }] },
        { id: 'bare', type: 'service', label: 'Bare', parent: null },
      ],
      [],
    );
    const b = scorer.scoreBindings(produced, root);
    expect(b.scored).toBe(true);
    // One of two citations resolves...
    expect(b.precision).toBe(0.5);
    expect(b.failures).toHaveLength(1);
    expect(b.failures[0].binding).toBe('repo=services/ghost/main.go');
    expect(b.failures[0].status).toBe('missing');
    // ...while two of three elements are cited at all. Two different facts.
    expect(b.coverage).toBeCloseTo(2 / 3, 4);
  });

  it('a line past the end of the file is stale, not ok', () => {
    const root = tree();
    const b = scorer.scoreBindings(
      doc([{ id: 'orders', type: 'service', label: 'O', parent: null, bindings: [{ source: 'repo', ref: 'services/orders/main.go', line: 99 }] }]),
      root,
    );
    expect(b.precision).toBe(0);
    expect(b.failures[0].status).toBe('stale');
  });

  it('an identifier ref is unchecked — in neither half of precision', () => {
    // `terraform=aws_ecs_service.orders` names a resource inside a file, not a
    // file. Scoring it as a hit would launder an invented identifier; scoring
    // it as a miss would report the most precise citation available for a
    // terraform resource as a failure. It is honestly unchecked.
    const root = tree();
    const b = scorer.scoreBindings(
      doc([
        { id: 'orders', type: 'service', label: 'O', parent: null, bindings: [
          { source: 'terraform', ref: 'aws_ecs_service.orders' },
          { source: 'compose', ref: 'docker-compose.yml' },
        ] },
      ]),
      root,
    );
    expect(b.unchecked).toBe(1);
    expect(b.precision).toBe(1); // one path binding, and it resolves
    expect(b.produced).toBe(2);
  });

  it('counts edges as elements — the half that had nowhere to put a citation', () => {
    const root = tree();
    const produced = doc(
      [
        { id: 'a', type: 'service', label: 'A', parent: null, bindings: [{ source: 'compose', ref: 'docker-compose.yml' }] },
        { id: 'b', type: 'service', label: 'B', parent: null, bindings: [{ source: 'compose', ref: 'docker-compose.yml' }] },
      ],
      [{ id: 'e1', from: 'a', to: 'b', bindings: [{ source: 'repo', ref: 'services/orders/main.go' }] }, { id: 'e2', from: 'b', to: 'a' }],
    );
    const b = scorer.scoreBindings(produced, root);
    expect(b.elements).toBe(4);
    expect(b.nodeCoverage).toBe(1);
    expect(b.edgeCoverage).toBe(0.5);
    expect(b.coverage).toBe(0.75);
  });

  it('reports unscored rather than perfect when no root is given', () => {
    const b = scorer.scoreBindings(
      doc([{ id: 'a', type: 'service', label: 'A', parent: null, bindings: [{ source: 'repo', ref: 'nope.go' }] }]),
      null,
    );
    expect(b.scored).toBe(false);
    expect(b.precision).toBeNull();
    // Coverage needs no filesystem, so it is still reported.
    expect(b.coverage).toBe(1);
    expect(b.why).toMatch(/--bindings-root/);
  });

  it('a ref that escapes the root fails, it does not resolve', () => {
    // V16 rejects ".." on every write path, so this document was hand-edited
    // past validation. The scorer reports it rather than reading outside the
    // tree it was pointed at.
    const root = tree();
    const b = scorer.scoreBindings(
      doc([{ id: 'a', type: 'service', label: 'A', parent: null, bindings: [{ source: 'repo', ref: '../../etc/passwd' }] }]),
      root,
    );
    expect(b.precision).toBe(0);
    expect(b.failures[0].status).toBe('malformed');
  });

  it('scores the hidden edge as cited only when the binding resolves (G12 + rule 15)', () => {
    // The measurement that could not exist before P5-01. Both answer keys say
    // the hidden edge counts as found only when the citation resolves to the
    // file the coupling is visible in.
    const gold = readGoldDoc('a');
    const root = tmpdir();
    fs.mkdirSync(path.join(root, 'fulfilment-worker', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fulfilment-worker', 'src', 'auth-client.js'), '1\n2\n3\n4\n5\n6\n7\n');

    const withBinding = JSON.parse(JSON.stringify(gold));
    const he = withBinding.edges.find((e: any) => e.from === 'fulfilment-worker' && e.to === 'auth');
    he.bindings = [{ source: 'repo', ref: 'fulfilment-worker/src/auth-client.js', line: 6 }];
    const cited = scorer.score(withBinding, scorer.loadGold(goldPath('a'), 'a', cfg), 'a', cfg, { bindingsRoot: root });
    expect(cited.hiddenEdge.found).toBe(true);
    expect(cited.hiddenEdge.citation.citedInBinding).toBe(true);
    expect(cited.hiddenEdge.citation.citedInResolvedBinding).toBe(true);

    // The same citation, one character wrong: it names the right kind of file
    // and points at nothing. Cited, but not evidence.
    const invented = JSON.parse(JSON.stringify(gold));
    const he2 = invented.edges.find((e: any) => e.from === 'fulfilment-worker' && e.to === 'auth');
    he2.bindings = [{ source: 'repo', ref: 'fulfilment-worker/src/auth-client.js', line: 4000 }];
    const guessed = scorer.score(invented, scorer.loadGold(goldPath('a'), 'a', cfg), 'a', cfg, { bindingsRoot: root });
    expect(guessed.hiddenEdge.citation.citedInBinding).toBe(true);
    expect(guessed.hiddenEdge.citation.citedInResolvedBinding).toBe(false);
  });

  it('accepts either honest reading of "repo-relative": the system dir or the workspace', () => {
    // Found by the first real smoke run, and it is the failure this whole
    // feature exists to prevent, pointed the wrong way. The rig runs the agent
    // with cwd = the workspace and the prompt pointing at ./system, so an agent
    // may write `services/orders/main.go` or `system/services/orders/main.go`
    // and both name the same file it actually opened. Resolving only against
    // the system directory reported 25 of 25 correct citations as missing —
    // binding precision 0.0 for perfect provenance. Both roots are inside the
    // run's own temp tree, so nothing the agent could not read becomes
    // resolvable, and a path in neither root is still missing.
    const ws = tmpdir();
    const root = path.join(ws, 'system');
    fs.mkdirSync(path.join(root, 'services', 'orders'), { recursive: true });
    fs.writeFileSync(path.join(root, 'services', 'orders', 'main.go'), 'a\nb\n');

    const prefixed = doc([
      { id: 'orders', type: 'service', label: 'O', parent: null, bindings: [{ source: 'repo', ref: 'system/services/orders/main.go' }] },
    ]);
    // One root: a correct citation scored as an invention.
    expect(scorer.scoreBindings(prefixed, root).precision).toBe(0);
    // Two roots: resolved, and the report says which spelling was used.
    const b = scorer.scoreBindings(prefixed, root, ws);
    expect(b.precision).toBe(1);
    expect(b.counts.viaAltRoot).toBe(1);

    // The unprefixed spelling still resolves against the system dir...
    const plain = doc([
      { id: 'orders', type: 'service', label: 'O', parent: null, bindings: [{ source: 'repo', ref: 'services/orders/main.go' }] },
    ]);
    const b2 = scorer.scoreBindings(plain, root, ws);
    expect(b2.precision).toBe(1);
    expect(b2.counts.viaAltRoot).toBe(0);

    // ...and a path in NEITHER root is still missing. The second root widens
    // the reading of a ref, it does not forgive an invented one.
    const invented = doc([
      { id: 'orders', type: 'service', label: 'O', parent: null, bindings: [{ source: 'repo', ref: 'services/orders/nope.go' }] },
    ]);
    expect(scorer.scoreBindings(invented, root, ws).precision).toBe(0);
  });

  it('does not give the alt-root credit for citing the rig\'s own scaffolding', () => {
    // The alt-root is the workspace, and `diagram init` has already written
    // CLAUDE.md, AGENTS.md, .mcp.json, the installed skill and — worst —
    // .diagram/graph.json, the document the agent is itself writing, into it
    // before the agent starts. Resolved against all of $ws, a citation of the
    // agent's own output scored as verified provenance. The fallback exists
    // for ONE reading ("system/..." spelled from one level up) and now gets
    // exactly that.
    const ws = tmpdir();
    const root = path.join(ws, 'system');
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'nginx.conf'), 'server {\n}\n');
    fs.mkdirSync(path.join(ws, '.diagram'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.diagram', 'graph.json'), '{}\n');
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# rules\n');

    const selfCiting = doc([
      { id: 'a', type: 'service', label: 'A', parent: null, bindings: [{ source: 'repo', ref: 'system/web/nginx.conf', line: 1 }] },
      { id: 'b', type: 'service', label: 'B', parent: null, bindings: [{ source: 'repo', ref: '.diagram/graph.json', line: 1 }] },
      { id: 'c', type: 'service', label: 'C', parent: null, bindings: [{ source: 'repo', ref: 'CLAUDE.md', line: 1 }] },
    ]);
    const b = scorer.scoreBindings(selfCiting, root, ws);
    // The honest one resolves; the two that name the harness do not.
    expect(b.resolved).toBe(1);
    expect(b.precision).toBe(0.3333);
    expect(b.counts.viaAltRoot).toBe(1);
    expect(b.counts.altRootRefused).toBe(2);
  });

  it('says out loud what share of the citations could not be resolved at all', () => {
    // Precision is computed over the citations that could be resolved, which
    // is right — and it means a document cited entirely as identifiers scores
    // precision null while reading as fully sourced. identifierShare is what
    // says so; aggregate.mjs flags a set where it dominates.
    const root = tmpdir();
    const idents = doc([
      { id: 'a', type: 'service', label: 'A', parent: null, bindings: [{ source: 'terraform', ref: 'aws_ecs_service.a' }] },
      { id: 'b', type: 'service', label: 'B', parent: null, bindings: [{ source: 'compose', ref: 'b-api' }] },
    ]);
    const b = scorer.scoreBindings(idents, root);
    expect(b.precision).toBeNull();
    expect(b.coverage).toBe(1);
    expect(b.identifierShare).toBe(1);
  });

  it('gold itself carries no bindings, so a gold-against-gold run is uncited, not wrong', () => {
    // The gold files predate P5-01 and are out of bounds for this milestone
    // (they are a signed-off M8 artefact). So coverage 0 against gold is the
    // correct answer, and precision is null rather than 0: nothing was claimed.
    const root = tmpdir();
    const b = scorer.scoreBindings(readGoldDoc('b'), root);
    expect(b.produced).toBe(0);
    expect(b.coverage).toBe(0);
    expect(b.precision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. aggregation — a mean alone hides a bimodal result
// ---------------------------------------------------------------------------

describe('harness — aggregation', () => {
  const runOf = (dir: number, run: number, invented = 0, hidden = true) => ({
    run,
    system: 'b',
    nodes: { precision: 1, recall: 1 },
    edges: { precision: 1, recall: 1 },
    direction: { accuracy: dir },
    invention: { count: invented, plantedAbsenceDrawn: invented > 0, plantedAbsence: { what: 'the position cache (Redis / ElastiCache)' } },
    hiddenEdge: {
      expected: 'maintenance-forecast -> dispatch',
      what: 'x',
      found: hidden,
      directionCorrect: hidden,
      // A clean run is one that found the edge AND can point at the source
      // file it read it out of (rule 9). See the G12 note in score.mjs.
      citation: {
        citedInDocument: hidden,
        accepted: 'internal/maintenance/forecast\\.go',
        // P5-02: the per-edge signal. A clean run cites the hidden edge with a
        // binding that actually resolves; `citedInDocument` is the older,
        // weaker document-text signal kept beside it.
        citedInBinding: hidden,
        citedInResolvedBinding: hidden,
      },
    },
    types: { accuracy: 1 },
    // A clean run cites what it read and every citation resolves (G10/G11).
    bindings: { scored: true, precision: 1, coverage: 1, produced: 8, resolved: 8, unchecked: 0, failures: [] },
  });

  it('flags a bimodal result rather than reporting a comfortable mean', () => {
    const out = aggregator.aggregate([runOf(1, 1), runOf(1, 2), runOf(1, 3), runOf(0.55, 4), runOf(0.55, 5), runOf(0.55, 6)], 'b');
    expect(out.summary['direction.accuracy'].mean).toBeCloseTo(0.775, 3);
    expect(out.summary['direction.accuracy'].spread).toBeCloseTo(0.45, 3);
    expect(out.flags.join('\n')).toMatch(/spread 0\.45 across 6 runs/);
    expect(out.flags.join('\n')).toMatch(/below the 0\.95 bar/);
  });

  it('keeps per-run detail, and counts the two planted checks over the set', () => {
    const out = aggregator.aggregate([runOf(1, 1), runOf(1, 2, 1), runOf(1, 3, 0, false)], 'b');
    expect(out.detail).toHaveLength(3);
    expect(out.planted.absence.drawnRuns).toBe(1);
    expect(out.planted.hiddenEdge.foundRuns).toBe(2);
    expect(out.flags.join('\n')).toMatch(/planted absence drawn in 1\/3 runs/);
    expect(out.flags.join('\n')).toMatch(/planted hidden edge missed in 1\/3 runs/);
  });

  it('a clean set of runs raises no flag', () => {
    const out = aggregator.aggregate([runOf(1, 1), runOf(1, 2), runOf(1, 3)], 'b');
    expect(out.flags).toEqual([]);
  });

  it('a null metric is excluded from the mean AND flagged, never silently dropped', () => {
    // An empty document scores direction.accuracy as null — correctly, since
    // 0/0 is not 0. Dropping those runs without saying so is how a 20-run G9
    // set with ten dead runs reports a clean 1.00: the dead runs are the hard
    // ones. The mean still excludes them; the flag says the mean is a subset.
    const dead = { ...runOf(1, 2), direction: { accuracy: null }, nodes: { precision: null, recall: 0 } };
    const out = aggregator.aggregate([runOf(1, 1), dead], 'b');
    expect(out.summary['direction.accuracy'].n).toBe(1);
    expect(out.summary['direction.accuracy'].absent).toBe(1);
    expect(out.summary['direction.accuracy'].mean).toBe(1);
    expect(out.flags.join('\n')).toMatch(/direction\.accuracy: scored in only 1\/2 run/);
    expect(out.flags.join('\n')).toMatch(/node\.precision: scored in only 1\/2 run/);
  });

  it('does not blame the harness for a run that cited nothing', () => {
    // binding.precision is null for two opposite reasons: no --bindings-root
    // reached the scorer (a harness gap), or one did and the agent produced
    // nothing to resolve — ratio(0,0) is null (an agent result). Hard-coding
    // the first explanation sends the reader to the rig when the finding is
    // about the agent, which is the inversion the code beside it warns about.
    const cited = {
      ...runOf(1, 1),
      bindings: { scored: true, root: '/tmp/x', precision: null, coverage: 0, produced: 0, resolved: 0, unchecked: 0, failures: [] },
    };
    const out = aggregator.aggregate([cited, { ...cited, run: 2 }], 'b');
    const flags = out.flags.join('\n');
    expect(flags).toMatch(/produced no resolvable citation/);
    expect(flags).not.toMatch(/scored without a --bindings-root/);
    // ...and the real finding is still on screen.
    expect(flags).toMatch(/binding\.coverage mean 0/);
  });

  it('flags a set whose citations are mostly unresolvable identifiers', () => {
    // A document cited entirely as `terraform=aws_ecs_service.<anything>` is
    // 100% unfalsifiable, exits 0, and reads as fully sourced. Precision is
    // honest about it (null, never 1.0); nothing said so out loud until now.
    const ident = {
      ...runOf(1, 1),
      bindings: { scored: true, precision: null, coverage: 1, produced: 8, resolved: 0, unchecked: 8, identifierShare: 1, failures: [] },
    };
    const out = aggregator.aggregate([ident, { ...ident, run: 2 }], 'b');
    expect(out.flags.join('\n')).toMatch(/16\/16 citations across the set are identifiers/);
  });

  it('runs that never produced a score are recorded, not erased', () => {
    // --runs 20 with 14 crashes must not be byte-identical to a deliberate
    // 6-run eval. eval.sh passes --attempted; the artifact carries all three.
    const out = aggregator.aggregate([runOf(1, 1), runOf(1, 2)], 'b', 6);
    expect(out.runsRequested).toBe(6);
    expect(out.runsScored).toBe(2);
    expect(out.runsFailed).toBe(4);
    expect(out.flags.join('\n')).toMatch(/4\/6 run\(s\) produced no score at all/);
  });

  it('flags the hidden edge found but drawn backwards — G12 passing while G9 fails', () => {
    // One reversed edge in twelve is a 0.083 dip in direction.accuracy, well
    // inside the 0.95 bar, and hiddenEdge.found is true. Without this flag the
    // single most important edge in the fixture can point the wrong way in
    // silence.
    const backwards = { ...runOf(1, 2), hiddenEdge: { ...runOf(1, 2).hiddenEdge, found: true, directionCorrect: false } };
    const out = aggregator.aggregate([runOf(1, 1), backwards], 'b');
    expect(out.planted.hiddenEdge.foundRuns).toBe(2);
    expect(out.planted.hiddenEdge.foundAndCorrectDirectionRuns).toBe(1);
    expect(out.flags.join('\n')).toMatch(/drawn BACKWARDS in 1\/2/);
  });

  it('flags a hidden edge drawn but never cited to source (rule 9)', () => {
    const uncited = { ...runOf(1, 2), hiddenEdge: { ...runOf(1, 2).hiddenEdge, citation: { citedInDocument: false } } };
    const out = aggregator.aggregate([runOf(1, 1), uncited], 'b');
    expect(out.planted.hiddenEdge.citedToSourceRuns).toBe(1);
    expect(out.flags.join('\n')).toMatch(/named in the document TEXT .* in only 1/);
  });

  // -------------------------------------------------------------------------
  // Provenance (P5-02, acceptance G10/G11)
  // -------------------------------------------------------------------------

  it('flags binding precision below 1.0 — the G10 bar (acceptance)', () => {
    // The honesty number. One invented citation in a run is a fail, because a
    // citation that does not resolve is worse than no citation: it reads as
    // evidence. 0.875 is seven of eight resolving.
    const sloppy = {
      ...runOf(1, 2),
      bindings: { scored: true, precision: 0.875, coverage: 1, produced: 8, resolved: 7, unchecked: 0, failures: [{ id: 'orders', binding: 'repo=services/orders/main.go', status: 'missing' }] },
    };
    const out = aggregator.aggregate([runOf(1, 1), sloppy], 'b');
    expect(out.summary['binding.precision'].mean).toBeCloseTo(0.9375, 4);
    expect(out.summary['binding.precision'].min).toBeCloseTo(0.875, 4);
    expect(out.flags.join('\n')).toMatch(/binding\.precision mean .* below the 1\.0 bar \(acceptance G10\)/);
    expect(out.bindings.failuresTotal).toBe(1);
  });

  it('keeps precision and coverage as separate numbers', () => {
    // The whole point of two numbers: an agent that cites ONE element and cites
    // it correctly is perfectly honest and almost entirely uncited. A single
    // combined score would call that a pass or call it a failure; both readings
    // are wrong, and the pair says exactly what happened.
    const oneCitedNode = {
      ...runOf(1, 2),
      bindings: { scored: true, precision: 1, coverage: 0.05, produced: 1, resolved: 1, unchecked: 0, failures: [] },
    };
    const out = aggregator.aggregate([oneCitedNode], 'b');
    expect(out.summary['binding.precision'].mean).toBe(1);
    expect(out.summary['binding.coverage'].mean).toBeCloseTo(0.05, 4);
    // No G10 flag: nothing it said was untrue.
    expect(out.flags.join('\n')).not.toMatch(/below the 1\.0 bar/);
    // But the effort is flagged, so nobody reads precision 1.0 as "fully cited".
    expect(out.flags.join('\n')).toMatch(/binding\.coverage mean 0\.05/);
  });

  it('says provenance was not measured rather than reporting it as perfect', () => {
    // A run scored without a --bindings-root (or by a harness older than
    // P5-02) has no binding numbers at all. Reporting those as 0 would be a
    // claim about the agent; reporting them as 1 would be a lie. They are
    // absent, and the flag says so.
    const unscored = { ...runOf(1, 1) } as Record<string, unknown>;
    delete unscored['bindings'];
    const out = aggregator.aggregate([unscored], 'b');
    expect(out.summary['binding.precision'].n).toBe(0);
    expect(out.summary['binding.precision'].mean).toBeNull();
    expect(out.bindings.scoredRuns).toBe(0);
    expect(out.flags.join('\n')).toMatch(/bindings were NOT resolved in any run/);
  });

  it('flags the hidden edge found but not cited by a binding that resolves', () => {
    // The measurement that could not exist before P5-01: an edge drawn but
    // pointing at no file it was read from is a lucky guess, and the benchmark
    // measured exactly that (found 20/20, cited 2/20) when GEdge had nowhere
    // to put a citation.
    const guessed = {
      ...runOf(1, 2),
      hiddenEdge: {
        ...runOf(1, 2).hiddenEdge,
        citation: { ...runOf(1, 2).hiddenEdge.citation, citedInBinding: false, citedInResolvedBinding: false },
      },
    };
    const out = aggregator.aggregate([runOf(1, 1), guessed], 'b');
    expect(out.planted.hiddenEdge.citedByResolvingBindingRuns).toBe(1);
    expect(out.flags.join('\n')).toMatch(/RESOLVING binding in only 1\/2/);
  });
});
