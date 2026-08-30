// tests/analyse.test.ts — `diagram analyse` and diagram_analyse (spec §15.3, §15.4).
//
// The computation belongs to core and is tested there. What is under test here
// is the SURFACE: the exact text an agent reads, and the four promises of the
// honesty contract that only the surface can break —
//
//   A1  the command writes nothing: not the document, not a history snapshot,
//       not a lock file. Asserted against the real directory, before and after.
//   A2  the analysis is of the STORED document. A collapsed view changes the
//       findings not at all, and the output says the view was ignored.
//   A3  nothing operational is asserted. The output carries numbers and the
//       names of the meta keys that exist, and no sentence claiming a load.
//   A4/A5 the coverage block is present in EVERY analysis, including the ones
//       with no findings, and it names what was excluded.
//
// Real temp .diagram/ directories, never the repository's own.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDoc, writeDocAtomic, type GraphDoc } from '../../core/src/index.js';
import { analyse } from '../../core/src/analysis/index.js';
import { createContext } from '../src/commands/context.js';
import { analyseCommand, renderAnalysis, runAnalyse } from '../src/commands/analyse.js';
import { callTool, findTool } from '../src/mcp/tools.js';

const cleanups: Array<() => void> = [];
const savedEnv = process.env['DIAGRAM_DIR'];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  vi.restoreAllMocks();
  process.exitCode = 0;
  if (savedEnv === undefined) delete process.env['DIAGRAM_DIR'];
  else process.env['DIAGRAM_DIR'] = savedEnv;
});

function tempDiagramDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-analyse-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, '.diagram');
}

function seeded(doc: GraphDoc): string {
  const dir = tempDiagramDir();
  writeDocAtomic(dir, doc);
  return dir;
}

/**
 * Two clients through a gateway into a service that both calls a database and
 * sits in a synchronous cycle with a second service, plus one dashed edge to a
 * queue and one entity node. Small, but it exercises every block of §15.4.
 */
function platform(): GraphDoc {
  return {
    ...emptyDoc(),
    title: 'Checkout platform',
    groups: [{ id: 'vpc-private', kind: 'vpc', label: 'Private VPC', parent: null }],
    nodes: [
      { id: 'web-client', label: 'Web', type: 'client', parent: null },
      { id: 'mobile', label: 'Mobile', type: 'client', parent: null },
      { id: 'api-gateway', label: 'API', type: 'service', parent: 'vpc-private' },
      {
        id: 'orders',
        label: 'Orders',
        type: 'service',
        parent: 'vpc-private',
        meta: { rps: '1200' },
      },
      { id: 'inventory', label: 'Inventory', type: 'service', parent: 'vpc-private' },
      { id: 'postgres', label: 'Postgres', type: 'database', parent: 'vpc-private' },
      { id: 'queue', label: 'Queue', type: 'queue', parent: 'vpc-private' },
      { id: 'customer', label: 'Customer', type: 'entity', parent: null },
    ],
    edges: [
      { id: 'e1', from: 'web-client', to: 'api-gateway', label: 'https' },
      { id: 'e2', from: 'mobile', to: 'api-gateway' },
      { id: 'e3', from: 'api-gateway', to: 'orders' },
      { id: 'e4', from: 'orders', to: 'postgres' },
      { id: 'e5', from: 'orders', to: 'inventory' },
      { id: 'e6', from: 'inventory', to: 'orders' },
      { id: 'e7', from: 'inventory', to: 'postgres' },
      { id: 'e8', from: 'orders', to: 'queue', label: 'emit', style: 'dashed' },
    ],
  };
}

/** Every line of one block, without its heading or its indent. */
function blockRows(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  expect(start, `block "${heading}" is missing from:\n${text}`).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    rows.push(line.slice(2));
  }
  return rows;
}

// ---------------------------------------------------------------------------

/** Seed a temp directory and analyse it, inside the test that needs it. */
function analysed(doc: GraphDoc = platform()): string {
  return runAnalyse({ dir: seeded(doc) }).text;
}

describe('the §15.4 output', () => {

  it('names the document and its scope on the first two lines', async () => {
    const [first, second] = analysed().split('\n');
    expect(first).toBe('analysis — Checkout platform');
    // A2, stated: seven runtime nodes, not the eight in the document — the
    // entity is excluded — and no mention of a view, because none is set.
    expect(second).toBe('scope: full document, 7 runtime nodes');
  });

  it('states fan-in split sync/async, and why each chokepoint is one', async () => {
    const text = analysed();
    const rows = blockRows(text, 'chokepoints');
    expect(rows.length).toBeGreaterThan(0);
    const orders = rows.find((r) => r.startsWith('orders'));
    expect(orders).toBeDefined();
    expect(orders).toContain('fan-in 2 (2 sync)');
    expect(orders).toContain('articulation point — isolates');
    expect(orders).toContain('reached by 2 entry points');
    // Aligned into a column, so the numbers can be read down the page: the
    // ids are padded to one width and `fan-in` starts at the same offset on
    // every row.
    expect(new Set(rows.map((r) => r.indexOf('fan-in'))).size).toBe(1);
  });

  it('never draws a cycle in the sync chain as a straight line', async () => {
    const text = analysed();
    const [chain] = blockRows(text, 'sync chains');
    expect(chain).toBeDefined();
    // The condensed step IS a loop, and is printed as one. A chain rendered
    // `orders → inventory` would claim a path that does not terminate.
    expect(chain).toContain('(orders ⇄ inventory)');
    expect(chain).toContain('through a cycle');
    // The depth is counted in CONDENSED steps and says so: a component of
    // twenty nodes is one step, and an unlabelled number reads as one hop.
    expect(chain).toMatch(/\(depth \d+ condensed steps, all sync/);
  });

  it('reports the cycle in its own right, closed', async () => {
    const text = analysed();
    expect(blockRows(text, 'sync cycles')).toEqual(['orders → inventory → orders']);
  });

  it('names the document root rather than leaving a boundary end blank', async () => {
    const text = analysed();
    expect(blockRows(text, 'boundary crossings')).toEqual(['vpc-private ↔ root: 2 edges']);
  });

  it('lists the entry points the shared-dependency counts are counted against', async () => {
    const text = analysed();
    expect(blockRows(text, 'entry points')).toEqual([
      'web-client (fan-out 1), mobile (fan-out 1)',
    ]);
  });
});

describe('the coverage block — A4 and A5', () => {
  it('says how many nodes carry no operational meta, and what was excluded', async () => {
    const rows = blockRows(analysed(), 'coverage');
    expect(rows).toContain('6 of 7 nodes carry no operational meta');
    expect(rows).toContain('1 entity node excluded (data model, not runtime)');
    expect(rows).toContain(
      'structural facts only: no traffic, latency or capacity is known to the document',
    );
  });

  it('prints core’s sentences verbatim, so the wording cannot drift', async () => {
    const doc = platform();
    const rows = blockRows(analysed(doc), 'coverage');
    for (const note of analyse(doc).notes) expect(rows).toContain(note);
  });

  it('names the meta keys available to attribute, and asserts nothing from them', async () => {
    const text = analysed();
    // Per key, with its own count. `keys` is a union and `withMeta` counts
    // nodes carrying ANY key, so pairing the two overstates coverage.
    expect(text).toContain('the only operational key it carries is rps (1 of 7)');
    expect(text).toContain('name the key when you state a number from it');
    // A3: the key is NAMED, its value is never restated as a finding, and no
    // sentence anywhere calls anything a bottleneck.
    expect(text).not.toContain('1200');
    expect(text.toLowerCase()).not.toContain('bottleneck');
  });

  it('appears even when there is nothing to report', async () => {
    const doc: GraphDoc = {
      ...emptyDoc(),
      title: 'Two islands',
      nodes: [
        { id: 'a', label: 'A', type: 'service', parent: null },
        { id: 'b', label: 'B', type: 'service', parent: null },
      ],
    };
    const text = analysed(doc);
    expect(text).toContain(
      'no chokepoints, sync chains, cycles or boundary crossings in this document',
    );
    expect(blockRows(text, 'coverage')).toContain('2 of 2 nodes carry no operational meta');
  });

  it('calls a pure ERD a data model rather than printing an empty report', async () => {
    const doc: GraphDoc = {
      ...emptyDoc(),
      title: 'Orders schema',
      nodes: [
        { id: 'customer', label: 'Customer', type: 'entity', parent: null },
        { id: 'order', label: 'Order', type: 'entity', parent: null },
      ],
      edges: [{ id: 'r1', from: 'customer', to: 'order', label: 'places', cardinality: '1:N' }],
    };
    const text = analysed(doc);
    expect(text).toContain('nothing to analyse — this document has no runtime nodes');
    expect(blockRows(text, 'coverage')).toContain(
      'this document is a data model, not a runtime: there is nothing to analyse',
    );
  });
});

describe('A2 — the full document, never the derived view', () => {
  it('finds exactly the same things with a group collapsed', async () => {
    const open = platform();
    const collapsed: GraphDoc = { ...open, collapsed: ['vpc-private'] };
    const openText = analysed(open);
    const collapsedText = analysed(collapsed);

    // Every finding is identical; the only difference is the scope line
    // saying so. If analysis ran on the derived view the collapsed run would
    // report one box with fan-in 2 and no chokepoints at all.
    const body = (t: string): string => t.split('\n').slice(2).join('\n');
    expect(body(collapsedText)).toBe(body(openText));
    expect(collapsedText.split('\n')[1]).toBe(
      'scope: full document, 7 runtime nodes — the collapsed view (vpc-private) is ignored here',
    );
  });
});

describe('A1 — analysis is a read', () => {
  it('changes no byte on disk and takes no history snapshot', async () => {
    const dir = seeded(platform());
    const graphFile = path.join(dir, 'graph.json');
    const before = fs.readFileSync(graphFile);
    const entriesBefore = fs.readdirSync(dir).sort();

    expect(runAnalyse({ dir }).ok).toBe(true);
    await callTool('diagram_analyse', {}, createContext({ dir }));

    expect(fs.readFileSync(graphFile).equals(before)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(entriesBefore);
    expect(fs.existsSync(path.join(dir, 'history'))).toBe(false);
  });
});

describe('a document that is not there, and one that cannot be read', () => {
  it('treats a project nobody has drawn in as ok, and says where it looked', async () => {
    const dir = tempDiagramDir();
    const result = runAnalyse({ dir });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.text).toContain(`nothing to analyse — no document yet at ${path.join(dir, 'graph.json')}`);
    expect(result.text).toContain('diagram patch');
  });

  it('fails readably on a corrupt document rather than analysing nothing', async () => {
    const dir = tempDiagramDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'graph.json'), '{ not json');
    const result = runAnalyse({ dir });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot read');
    // Never a hollow "0 runtime nodes" over a file it could not parse.
    expect(result.text).not.toContain('analysis —');
  });
});

describe('the command body', () => {
  it('writes the analysis to stdout and leaves the exit code at 0', async () => {
    const dir = seeded(platform());
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
    const result = analyseCommand({ dir });
    expect(out).toBe(`${result.text}\n`);
    expect(err).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('renders from data alone, with no disk access', async () => {
    const doc = platform();
    expect(renderAnalysis(analyse(doc), doc)).toBe(analysed(doc));
  });
});

describe('diagram_analyse — the eighth tool', () => {
  const tool = findTool('diagram_analyse');

  it('is advertised as a read that takes no arguments', async () => {
    expect(tool).toBeDefined();
    expect(tool?.annotations.readOnlyHint).toBe(true);
    expect(Object.keys((tool?.inputSchema['properties'] ?? {}) as object)).toEqual([]);
  });

  it('carries A2 and A3 in its description, since the description is the prompt', async () => {
    const description = tool?.description ?? '';
    expect(description).toContain('FULL document');
    expect(description).toContain('never the collapsed view');
    expect(description).toContain('STRUCTURAL');
    expect(description).toContain('`meta` key');
  });

  it('refuses an argument it does not take rather than ignoring it', async () => {
    const result = await callTool('diagram_analyse', { view: true }, createContext({ dir: seeded(platform()) }));
    expect(result.ok).toBe(false);
    expect(result.text).toContain('unknown argument "view" for diagram_analyse');
  });
});

// ---------------------------------------------------------------------------
// The arrows. `→` means caller → callee everywhere in this output (§4.4 rule
// 4), so an arrow the document does not contain is direction invention on the
// one surface of Part 15 that asserts direction at all.
// ---------------------------------------------------------------------------

describe('cycles are printed with real edges only', () => {
  function cycleDoc(): GraphDoc {
    // Nodes a, b, c in that order; the real loop is a → c → b → a.
    return {
      ...emptyDoc(),
      title: 'Reversed',
      nodes: [
        { id: 'a', type: 'service', label: 'a', parent: null },
        { id: 'b', type: 'service', label: 'b', parent: null },
        { id: 'c', type: 'service', label: 'c', parent: null },
        { id: 'w', type: 'client', label: 'w', parent: null },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'c' },
        { id: 'e2', from: 'c', to: 'b' },
        { id: 'e3', from: 'b', to: 'a' },
        { id: 'e4', from: 'w', to: 'a' },
      ],
    };
  }

  it('walks the cycle in edge order, not document order', () => {
    const d = cycleDoc();
    const text = renderAnalysis(analyse(d), d);
    expect(text).toContain('a → c → b → a');
    expect(text).not.toContain('a → b → c → a');
  });

  it('never claims a mutual pair it did not check', () => {
    // `⇄` asserts an edge each way. A one-way ring of three has no mutual
    // pair anywhere, so the chain step must not use the notation.
    const d = cycleDoc();
    const text = renderAnalysis(analyse(d), d);
    expect(text).toContain('(cycle of 3: a, b, c)');
    expect(text).not.toContain('⇄');
  });

  it('names the members a real loop does not cover', () => {
    const d: GraphDoc = {
      ...emptyDoc(),
      title: 'Not a ring',
      nodes: ['a', 'b', 'c', 'dd', 'e'].map((id) => ({
        id,
        type: 'service' as const,
        label: id,
        parent: null,
      })),
      edges: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'a' },
        { id: 'e3', from: 'b', to: 'c' },
        { id: 'e4', from: 'c', to: 'dd' },
        { id: 'e5', from: 'dd', to: 'e' },
        { id: 'e6', from: 'e', to: 'b' },
      ],
    };
    const text = renderAnalysis(analyse(d), d);
    expect(text).toContain('a → b → a   (+3 more in the same cycle: c, dd, e)');
    // the ring the old renderer drew closed with an edge that does not exist
    expect(text).not.toContain('e → a');
  });

  it('says the synchronous subgraph is one cycle rather than dropping the block', () => {
    const d: GraphDoc = {
      ...emptyDoc(),
      title: 'All loop',
      nodes: ['a', 'b', 'c'].map((id) => ({
        id,
        type: 'service' as const,
        label: id,
        parent: null,
      })),
      edges: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'c' },
        { id: 'e3', from: 'c', to: 'a' },
      ],
    };
    const text = renderAnalysis(analyse(d), d);
    expect(text).toContain('sync chains');
    expect(text).toContain('does not extend beyond a single cycle');
  });
});

describe('coverage attributes each key to its own count', () => {
  it('never pairs a key list with a whole-document node count', () => {
    const d: GraphDoc = {
      ...emptyDoc(),
      title: 'Keys',
      nodes: [
        { id: 'web', type: 'service', label: 'web', parent: null, meta: { rps: '1' } },
        {
          id: 'api',
          type: 'service',
          label: 'api',
          parent: null,
          meta: { rps: '2', p99: '3ms' },
        },
        { id: 'db', type: 'database', label: 'db', parent: null, meta: { instances: '3' } },
      ],
      edges: [
        { id: 'e1', from: 'web', to: 'api' },
        { id: 'e2', from: 'api', to: 'db' },
      ],
    };
    const text = renderAnalysis(analyse(d), d);
    expect(text).toContain('instances (1 of 3), p99 (1 of 3), rps (2 of 3)');
    expect(text).not.toContain('on 3 of 3 nodes');
  });
});

describe('A5 has no exception', () => {
  it('reports coverage even when there is no document at all', () => {
    const dir = tempDiagramDir();
    const out = runAnalyse({ dir });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('coverage: no document, so nothing is known about anything');
  });
});
