// tests/writeCommands.test.ts — the write-side CLI commands (spec §4.2).
//
// patch / undo / redo / export / reset, driven through their exported run*
// bodies against real temp .diagram/ directories: real locks, real history
// snapshots, real files. Nothing is mocked, because the properties under
// test — "a rejected patch leaves graph.json byte-identical", "undo past the
// start does not throw" — only exist on disk.
//
// Every test writes into an OS temp directory. Nothing here may touch the
// repo's own .diagram/.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { readDoc, type GraphDoc, type GraphPatch } from '../../core/src/index.js';
import { deriveView } from '../../core/src/view/derive.js';
import { createContext, type CommandOutput } from '../src/commands/context.js';
import { parsePatchText, runPatch, runPatchText } from '../src/commands/patch.js';
import { runUndo } from '../src/commands/undo.js';
import { runRedo } from '../src/commands/redo.js';
import { DEFAULT_JSON_OUT, defaultOutPath, runExport } from '../src/commands/export.js';
// The viewer's measurement seam. Not a mock of the export path — it is the
// real knob §5.1 sizing turns, and the only honest way to drive the one
// failure the renderer raises (a measurement that is not answering).
import { setMeasureStrategy } from '../../viewer/src/layout/measure.js';
import { parseDocText, runImport, runImportText } from '../src/commands/import.js';
import { runReset } from '../src/commands/reset.js';
import { runView, runViewCollapsed, runViewDepth } from '../src/commands/view.js';

/** Set doc.collapsed through the real locked write path, as `diagram view` does. */
function applyCollapsedIds(dir: string, ids: string[]): CommandOutput {
  return runViewCollapsed(ids, { dir });
}

const cleanups: Array<() => void> = [];
const savedEnv = process.env['DIAGRAM_DIR'];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  if (savedEnv === undefined) delete process.env['DIAGRAM_DIR'];
  else process.env['DIAGRAM_DIR'] = savedEnv;
});

function tempDir(prefix = 'diagram-write-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fresh, empty .diagram/ directory inside a temp project. */
function tempDiagramDir(): string {
  return path.join(tempDir(), '.diagram');
}

const addApi: GraphPatch = {
  ops: [
    {
      op: 'addNode',
      node: { id: 'api', label: 'API', type: 'service', parent: null },
    },
  ],
  summary: 'add api',
};

const addWeb: GraphPatch = {
  ops: [
    {
      op: 'addNode',
      node: { id: 'web', label: 'Web', type: 'client', parent: null },
    },
  ],
  summary: 'add web',
};

/** Apply a patch through the command body, asserting it succeeded. */
function applyOk(dir: string, patch: GraphPatch): CommandOutput {
  const out = runPatchText(JSON.stringify(patch), 'test', { dir });
  expect(out.stderr).toBe('');
  expect(out.code).toBe(0);
  return out;
}

function graphFile(dir: string): string {
  return createContext({ dir }).paths.graphFile;
}

// ---------------------------------------------------------------------------
// patch — parsing
// ---------------------------------------------------------------------------

describe('parsePatchText', () => {
  it('accepts a well-formed patch', () => {
    const result = parsePatchText(JSON.stringify(addApi), 'stdin');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.ops).toHaveLength(1);
  });

  it('names the source and the expected shape when the text is empty', () => {
    const result = parsePatchText('   \n', 'stdin');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('stdin: no patch text');
      expect(result.errors[0]).toContain('"ops"');
    }
  });

  it('reports malformed JSON with the parser message and the shape', () => {
    const result = parsePatchText('{"ops": [', 'stdin');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('stdin: not valid JSON');
      expect(result.errors.join('\n')).toContain('"summary"');
    }
  });

  it('reports schema failures per path, so the agent knows which op to fix', () => {
    const result = parsePatchText('{"ops":[{"op":"nope"}],"summary":"x"}', 'stdin');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('not a valid patch');
      expect(result.errors.join('\n')).toContain('ops.0');
    }
  });

  it('rejects a patch missing its summary', () => {
    const result = parsePatchText('{"ops":[]}', 'stdin');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('summary');
  });
});

// ---------------------------------------------------------------------------
// patch — applying
// ---------------------------------------------------------------------------

describe('runPatch', () => {
  it('applies a patch read from stdin and prints the ok shape', async () => {
    const dir = tempDiagramDir();
    const out = await runPatch({ stdin: true, dir }, Readable.from(JSON.stringify(addApi)));
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout.split('\n')[0]).toMatch(/^ok — /);
    expect(out.stdout).toContain('graph: 1 node, 0 groups, 0 edges');

    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.nodes.map((n) => n.id)).toEqual(['api']);
  });

  it('applies a patch read from --file', async () => {
    const dir = tempDiagramDir();
    const file = path.join(tempDir(), 'ops.json');
    fs.writeFileSync(file, JSON.stringify(addApi), 'utf8');

    const out = await runPatch({ file, dir });
    expect(out.code).toBe(0);
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.nodes).toHaveLength(1);
  });

  it('prefers --file over stdin when both are given', async () => {
    const dir = tempDiagramDir();
    const file = path.join(tempDir(), 'ops.json');
    fs.writeFileSync(file, JSON.stringify(addApi), 'utf8');

    const out = await runPatch(
      { file, stdin: true, dir },
      Readable.from(JSON.stringify(addWeb)),
    );
    expect(out.code).toBe(0);
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.nodes.map((n) => n.id)).toEqual(['api']);
  });

  it('rejects a missing --file with the OS message, on stderr, exit 1', async () => {
    const dir = tempDiagramDir();
    const out = await runPatch({ file: path.join(dir, 'nope.json'), dir });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('rejected — no changes applied');
    expect(out.stderr).toContain('ENOENT');
    expect(fs.existsSync(graphFile(dir))).toBe(false);
  });

  it('rejects malformed JSON from stdin without creating a document', async () => {
    const dir = tempDiagramDir();
    const out = await runPatch({ stdin: true, dir }, Readable.from('{not json'));
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('not valid JSON');
    expect(fs.existsSync(graphFile(dir))).toBe(false);
  });

  it('leaves graph.json byte-identical when a patch is rejected', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    const before = fs.readFileSync(graphFile(dir));

    // An edge to a node that does not exist: valid JSON, valid schema,
    // rejected by the document invariants.
    const bad: GraphPatch = {
      ops: [{ op: 'addEdge', edge: { id: 'e1', from: 'api', to: 'ghost' } }],
      summary: 'dangling edge',
    };
    const out = await runPatch({ stdin: true, dir }, Readable.from(JSON.stringify(bad)));

    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('rejected — no changes applied');
    expect(fs.readFileSync(graphFile(dir))).toEqual(before);
  });

  it('leaves graph.json byte-identical when the patch text is garbage', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    const before = fs.readFileSync(graphFile(dir));

    await runPatch({ stdin: true, dir }, Readable.from(']['));
    expect(fs.readFileSync(graphFile(dir))).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// undo / redo
// ---------------------------------------------------------------------------

describe('runUndo / runRedo', () => {
  it('steps back and forward through history', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    applyOk(dir, addWeb);

    const undone = runUndo({ dir });
    expect(undone.code).toBe(0);
    expect(undone.stdout).toContain('graph: 1 node');
    let doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.nodes.map((n) => n.id)).toEqual(['api']);

    const redone = runRedo({ dir });
    expect(redone.code).toBe(0);
    expect(redone.stdout).toContain('graph: 2 nodes');
    doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.nodes.map((n) => n.id)).toEqual(['api', 'web']);
  });

  it('undoing past the start rejects cleanly instead of throwing', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);

    expect(runUndo({ dir }).code).toBe(0); // back to the empty base snapshot
    const out = runUndo({ dir });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('nothing to undo');
    expect(out.stderr).toContain('oldest state');
  });

  it('undoing with no history at all rejects cleanly', () => {
    const out = runUndo({ dir: tempDiagramDir() });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('nothing to undo');
  });

  it('redoing at the newest state rejects cleanly', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    const out = runRedo({ dir });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('nothing to redo');
  });
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

describe('runExport', () => {
  it('writes the document to .diagram/out.json by default', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);

    const out = await runExport({ dir });
    expect(out.code).toBe(0);
    const target = defaultOutPath(createContext({ dir }), 'json');
    expect(out.stdout).toContain(target);

    const written: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(written).toEqual(JSON.parse(fs.readFileSync(graphFile(dir), 'utf8')));
  });

  it('honours --out, resolved against the cwd', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    const target = path.join(tempDir(), 'nested', 'arch.json');

    const out = await runExport({ dir, format: 'json', out: target });
    expect(out.code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('points png at the viewer instead of writing a file no viewer can open', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);

    const out = await runExport({ dir, format: 'png', out: path.join(dir, 'a.png') });
    expect(out.code).toBe(1);
    // The refusal has to name where PNG actually lives, or the agent retries
    // the same call. And nothing may be written under the .png name.
    expect(out.stderr).toContain('diagram serve');
    expect(out.stderr).toContain('rasteriser');
    expect(fs.existsSync(path.join(dir, 'a.png'))).toBe(false);
  });

  it('refuses an unknown format', async () => {
    const out = await runExport({ dir: tempDiagramDir(), format: 'pdf' });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('unknown export format "pdf"');
  });

  it('reports an unreadable document the way get and check do, not as a write', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    fs.writeFileSync(graphFile(dir), '{ not json', 'utf8');

    const out = await runExport({ dir });
    expect(out.code).toBe(1);
    // export never writes the document, so "no changes applied" is a promise
    // about something that was never at risk; the agent must recognise the one
    // failure it has to fix — the broken file — by the same shape everywhere.
    expect(out.stderr.split('\n')[0]).toBe(`cannot read ${graphFile(dir)}`);
    expect(out.stderr).toContain('not valid JSON');
  });

  it('says "nothing written", not "no changes applied", when it refuses', async () => {
    const out = await runExport({ dir: tempDiagramDir(), format: 'png' });
    expect(out.stderr.split('\n')[0]).toBe('rejected — nothing written');
  });

  it('refuses to export a project with no document', async () => {
    const dir = tempDiagramDir();
    const out = await runExport({ dir });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('no diagram at');
    expect(fs.existsSync(defaultOutPath(createContext({ dir }), 'json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// export svg — driven against the REAL headless renderer
// ---------------------------------------------------------------------------
//
// There is no injection seam any more: commands/export.ts imports the
// viewer's headless export statically (see its header), so these tests drive
// the same binding the built binary does. That means the assertions are on
// the FILE — which boxes are in it — rather than on what a fake was handed,
// which is the stronger property anyway: a stub can agree with a command
// that draws the wrong picture.

/** Read the .svg this dir's export wrote. */
function readSvg(dir: string): string {
  return fs.readFileSync(createContext({ dir }).paths.svgFile, 'utf8');
}

/** Which node boxes the exported picture actually contains. */
function nodesIn(svg: string): string[] {
  return [...svg.matchAll(/data-node="([^"]+)"[^>]*data-layer="node-box"/g)]
    .map((m) => m[1] as string)
    .sort();
}

/** api + db inside a vpc, so there is something to collapse. */
const seedVpc: GraphPatch = {
  ops: [
    { op: 'addGroup', group: { id: 'vpc', label: 'VPC', kind: 'vpc', parent: null } },
    { op: 'addNode', node: { id: 'api', label: 'API', type: 'service', parent: 'vpc' } },
    { op: 'addNode', node: { id: 'db', label: 'DB', type: 'database', parent: 'vpc' } },
    { op: 'addNode', node: { id: 'web', label: 'Web', type: 'client', parent: null } },
    { op: 'addEdge', edge: { id: 'e1', from: 'web', to: 'api', label: 'calls' } },
    { op: 'addEdge', edge: { id: 'e2', from: 'web', to: 'db', label: 'reads' } },
  ],
  summary: 'seed',
};

describe('runExport svg', () => {
  it('writes .diagram/out.svg by default and says which view it drew', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, seedVpc);

    const out = await runExport({ dir, format: 'svg' });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    const target = createContext({ dir }).paths.svgFile;
    expect(out.stdout.split('\n')[0]).toBe('ok — exported svg');
    expect(out.stdout).toContain(`wrote: ${target}`);
    expect(out.stdout).toContain('view: full graph — nothing collapsed');

    // A real file a browser will open, not a placeholder: if the static
    // binding to the viewer's headless export ever breaks, this is what says
    // so, in the tests AND (see the build smoke test) in the binary.
    const svg = readSvg(dir);
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox=');
    expect(nodesIn(svg)).toEqual(['api', 'db', 'web']);
  });

  it('exports the DERIVED document when a view is set — what the viewer shows', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, seedVpc);
    expect(applyCollapsedIds(dir, ['vpc']).code).toBe(0);

    const out = await runExport({ dir, format: 'svg' });
    expect(out.code).toBe(0);

    // The picture in the file: api and db are gone behind one stand-in box
    // carrying the group's own id, which is exactly deriveView's contract.
    const svg = readSvg(dir);
    expect(nodesIn(svg)).toEqual(['vpc', 'web']);
    expect(svg).toContain('VPC');

    // ...and the same pure pass, on the STORED document, is what the result
    // line describes, so the file and the transcript cannot disagree.
    const read = readDoc(graphFile(dir));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const drawn = deriveView(read.doc, read.doc.collapsed);
    expect(drawn.nodes.map((n) => n.id).sort()).toEqual(['vpc', 'web']);
    expect(drawn.groups).toHaveLength(0);
    expect(drawn.edges).toHaveLength(1);
    expect(out.stdout).toContain('view: collapsed vpc (1 of 1 group), 2 elements hidden');
    // The `graph:` line still counts the STORED document, as every other
    // command's does — the derived one is a picture, not the diagram.
    expect(out.stdout).toContain('graph: 3 nodes, 1 group, 2 edges');
  });

  it('--full ignores the stored collapsed view and says so', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, seedVpc);
    expect(applyCollapsedIds(dir, ['vpc']).code).toBe(0);

    const out = await runExport({ dir, format: 'svg', full: true });
    expect(out.code).toBe(0);
    // The flag passes [] rather than leaving the collapse list to a default,
    // so a renderer falling back to doc.collapsed cannot draw the collapsed
    // picture behind the flag's back. The proof is the boxes in the file.
    expect(nodesIn(readSvg(dir))).toEqual(['api', 'db', 'web']);
    expect(out.stdout).toContain('view: full graph (--full)');
  });

  it('really collapses: the exported svg differs once a view is set', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, seedVpc);

    expect((await runExport({ dir, format: 'svg' })).code).toBe(0);
    const open = readSvg(dir);

    expect(applyCollapsedIds(dir, ['vpc']).code).toBe(0);
    expect((await runExport({ dir, format: 'svg' })).code).toBe(0);
    expect(readSvg(dir)).not.toBe(open);

    // --full on the same stored document gives the open picture back, byte
    // for byte, which is the property the flag exists for.
    expect((await runExport({ dir, format: 'svg', full: true })).code).toBe(0);
    expect(readSvg(dir)).toBe(open);
  });

  it('says a collapsed id that is no longer a group did not collapse anything', async () => {
    // doc.collapsed is persisted and a hand-edited document can name a group
    // that is gone. deriveView ignores it rather than refusing to draw, so
    // the result line must not claim a collapse that did not happen.
    const dir = tempDiagramDir();
    applyOk(dir, seedVpc);
    const doc = readDoc(graphFile(dir));
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    fs.writeFileSync(
      graphFile(dir),
      JSON.stringify({ ...doc.doc, collapsed: ['ghost'] }, null, 2),
      'utf8',
    );

    const out = await runExport({ dir, format: 'svg' });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('view: full graph — collapsed ghost is not a group');
    expect(nodesIn(readSvg(dir))).toEqual(['api', 'db', 'web']);
  });

  it('reports a renderer that throws without leaving a half-written file', async () => {
    // The renderer's one refusal: text measurement pinned at zero would lay
    // out a heap of identical minimum-width boxes and raise nothing at all,
    // so it asserts on the measurement path first and throws. Driving it
    // through the real seam proves the CLI turns that into a clean exit-1
    // with no file, rather than a stack trace or a broken .svg.
    const dir = tempDiagramDir();
    applyOk(dir, seedVpc);
    setMeasureStrategy(() => 0);
    cleanups.push(() => setMeasureStrategy(null));

    const out = await runExport({ dir, format: 'svg' });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('svg render failed:');
    expect(fs.existsSync(createContext({ dir }).paths.svgFile)).toBe(false);
  });

  it('serves json without touching the renderer at all', async () => {
    // json is the stored bytes on both surfaces and must not depend on
    // anything the SVG path needs — including a working canvas.
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    setMeasureStrategy(() => 0);
    cleanups.push(() => setMeasureStrategy(null));
    const target = path.join(tempDir(), 'a.json');

    const out = await runExport({ dir, format: 'json', out: target });
    expect(out.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).nodes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/** A minimal valid document, as `diagram export json` would have written it. */
function docText(over: Partial<GraphDoc> = {}): string {
  const doc: GraphDoc = {
    schemaVersion: 1,
    title: 'Imported',
    direction: 'DOWN',
    nodes: [{ id: 'api', label: 'API', type: 'service', parent: null }],
    groups: [],
    edges: [],
    collapsed: [],
    ...over,
  };
  return JSON.stringify(doc, null, 2);
}

describe('parseDocText', () => {
  it('names the command the agent actually wanted when handed a patch', () => {
    const parsed = parseDocText(JSON.stringify(addApi), 'stdin');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join('\n')).toContain('`diagram patch`');
  });

  it('separates "not JSON" from "JSON but not a document"', () => {
    const bad = parseDocText('{ nope', 'stdin');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain('not valid JSON');

    const shaped = parseDocText('{"schemaVersion":1}', 'stdin');
    expect(shaped.ok).toBe(false);
    if (!shaped.ok) expect(shaped.errors[0]).toContain('not a valid diagram document');
  });

  it('runs the V1-V13 invariants, not just the schema', () => {
    // Schema-valid: an edge with two string endpoints. Invariant-invalid: V5,
    // neither endpoint exists. An import must be held to exactly what a patch is.
    const parsed = parseDocText(
      docText({ edges: [{ id: 'e1', from: 'api', to: 'ghost', label: 'calls' }] }),
      'stdin',
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]).toContain('invalid diagram');
    expect(parsed.errors.join('\n')).toContain('unknown node "ghost"');
  });

  it('rejects an empty input rather than importing the empty document', () => {
    const parsed = parseDocText('   ', 'stdin');
    expect(parsed.ok).toBe(false);
  });
});

describe('runImport', () => {
  it('creates the diagram in a fresh project with no --confirm', () => {
    const dir = tempDiagramDir();
    const out = runImportText(docText(), 'stdin', { dir });
    expect(out.code).toBe(0);
    expect(out.stdout.split('\n')[0]).toContain('ok — imported "Imported"');
    expect(out.stdout).toContain('replaced: nothing');
    expect(out.stdout).toContain('graph: 1 node, 0 groups, 0 edges');
    const written = readDoc(graphFile(dir));
    expect(written.ok && written.doc.title).toBe('Imported');
  });

  it('refuses to replace a non-empty diagram without --confirm, and changes nothing', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    const before = fs.readFileSync(graphFile(dir));

    const out = runImportText(docText({ title: 'Other' }), 'stdin', { dir });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('REPLACES the whole diagram');
    expect(out.stderr).toContain('--confirm');
    expect(fs.readFileSync(graphFile(dir))).toEqual(before);
  });

  it('replaces with --confirm, and `diagram undo` puts the old diagram back', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    const before = readDoc(graphFile(dir));

    const out = runImportText(docText({ title: 'Other' }), 'stdin', { dir, confirm: true });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('replaced: 1 node, 0 groups, 0 edges');

    const undone = runUndo({ dir });
    expect(undone.code).toBe(0);
    const back = readDoc(graphFile(dir));
    expect(back.ok && back.doc).toEqual(before.ok ? before.doc : undefined);
  });

  it('is the way out of a hand-corrupted graph.json, but still asks first', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    fs.writeFileSync(graphFile(dir), '{ not json', 'utf8');

    const refused = runImportText(docText(), 'stdin', { dir });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('no longer parses');

    const out = runImportText(docText(), 'stdin', { dir, confirm: true });
    expect(out.code).toBe(0);
    expect(readDoc(graphFile(dir)).ok).toBe(true);
  });

  it('rejects an invalid document in the same shape as `diagram patch`', () => {
    const dir = tempDiagramDir();
    const out = runImportText('{"schemaVersion":1}', 'stdin', { dir });
    expect(out.code).toBe(1);
    expect(out.stderr.split('\n')[0]).toBe('rejected — no changes applied');
    expect(fs.existsSync(graphFile(dir))).toBe(false);
  });

  it('reads from a file, and from stdin by default', async () => {
    const dir = tempDiagramDir();
    const file = path.join(tempDir(), 'arch.json');
    fs.writeFileSync(file, docText({ title: 'From file' }), 'utf8');
    expect((await runImport({ dir, file })).code).toBe(0);

    const piped = await runImport(
      { dir, confirm: true },
      Readable.from([docText({ title: 'From stdin' })]),
    );
    expect(piped.code).toBe(0);
    const written = readDoc(graphFile(dir));
    expect(written.ok && written.doc.title).toBe('From stdin');
  });

  it('names the missing file rather than the document shape', async () => {
    const out = await runImport({ dir: tempDiagramDir(), file: path.join(tempDir(), 'nope.json') });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('nope.json');
  });

  it('round-trips through `diagram export json`', async () => {
    const from = tempDiagramDir();
    applyOk(from, addApi);
    const file = path.join(tempDir(), 'round.json');
    expect((await runExport({ dir: from, format: 'json', out: file })).code).toBe(0);

    const to = tempDiagramDir();
    expect((await runImport({ dir: to, file })).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(graphFile(to), 'utf8'))).toEqual(
      JSON.parse(fs.readFileSync(graphFile(from), 'utf8')),
    );
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('runReset', () => {
  it('refuses without --confirm and changes nothing', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    const before = fs.readFileSync(graphFile(dir));

    const out = runReset({ dir });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--confirm');
    expect(fs.readFileSync(graphFile(dir))).toEqual(before);
  });

  it('clears the document with --confirm, and undo brings it back', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);

    const out = runReset({ dir, confirm: true });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('graph: 0 nodes, 0 groups, 0 edges');
    let doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.nodes).toEqual([]);

    expect(runUndo({ dir }).code).toBe(0);
    doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.nodes.map((n) => n.id)).toEqual(['api']);
  });

  it('works on a project that has no document yet', () => {
    const dir = tempDiagramDir();
    const out = runReset({ dir, confirm: true });
    expect(out.code).toBe(0);
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.nodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M7 follow-ups: the view is reported where it can otherwise move invisibly
// ---------------------------------------------------------------------------

describe('undo / redo of a view change say what moved', () => {
  it('reports the restored view, because no count moves with it', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    applyOk(dir, {
      ops: [{ op: 'addGroup', group: { id: 'vpc', kind: 'vpc', label: 'VPC', parent: null } }],
      summary: 'add vpc',
    });
    expect(runViewCollapsed(['vpc'], { dir }).code).toBe(0);

    const undone = runUndo({ dir });
    expect(undone.code).toBe(0);
    expect(undone.stdout).toContain('view: full graph — nothing collapsed (was: collapsed vpc)');

    const redone = runRedo({ dir });
    expect(redone.stdout).toContain('view: collapsed vpc');
    expect(redone.stdout).toContain('(was: nothing collapsed)');
  });

  it('says nothing about the view when the undo changed elements instead', () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    applyOk(dir, addWeb);
    const undone = runUndo({ dir });
    expect(undone.code).toBe(0);
    expect(undone.stdout).not.toContain('view:');
  });
});

describe('runExport refuses an EMPTY document, not just a missing one', () => {
  it('refuses svg with a next step, and writes no file', async () => {
    const dir = tempDiagramDir();
    // `diagram init` leaves exactly this: a real graph.json holding nothing.
    fs.mkdirSync(dir, { recursive: true });
    applyOk(dir, addApi);
    const reset = runReset({ dir, confirm: true });
    expect(reset.code).toBe(0);

    const out = await runExport({ dir, format: 'svg' });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('is empty — add nodes with `diagram patch` before exporting');
    expect(fs.existsSync(defaultOutPath(createContext({ dir }), 'svg'))).toBe(false);
  });

  it('still distinguishes "no diagram here at all"', async () => {
    const out = await runExport({ dir: tempDiagramDir(), format: 'svg' });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('no diagram at');
  });
});

describe('import warns about a collapsed id that names no group', () => {
  it('imports, and says the id will be ignored when drawing', () => {
    const dir = tempDiagramDir();
    const doc = {
      schemaVersion: 1,
      title: 'C',
      direction: 'DOWN',
      nodes: [{ id: 'a', type: 'service', label: 'A', parent: null }],
      groups: [],
      edges: [],
      collapsed: ['a', 'nosuch'],
    };
    const out = runImportText(JSON.stringify(doc), 'test', { dir, confirm: true });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('note: collapsed "a", "nosuch" are not groups');
    expect(out.stdout).toContain('this diagram has no groups');
  });
});

// ---------------------------------------------------------------------------
// The view stored as a rule: `diagram view --depth N`
// ---------------------------------------------------------------------------

describe('diagram view --depth', () => {
  /** registry > (sources, pull), pull > inner — a wrapper, two stages, one nested. */
  function stages(dir: string): void {
    applyOk(dir, {
      summary: 'a wrapped, two-stage diagram',
      ops: [
        { op: 'addGroup', group: { id: 'registry', kind: 'generic', label: 'Registry', parent: null } },
        { op: 'addGroup', group: { id: 'sources', kind: 'generic', label: 'Sources', parent: 'registry' } },
        { op: 'addGroup', group: { id: 'pull', kind: 'generic', label: 'Pull', parent: 'registry' } },
        { op: 'addGroup', group: { id: 'inner', kind: 'generic', label: 'Inner', parent: 'pull' } },
      ],
    });
  }

  it('stores the level and derives the list from it', () => {
    const dir = tempDiagramDir();
    stages(dir);
    const out = runViewDepth(1, { dir });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('rule: depth 1');
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.view).toEqual({ depth: 1 });
    expect(doc.ok && doc.doc.collapsed).toEqual(['sources', 'pull']);
  });

  it('keeps the view true when a later patch adds a group at that level', () => {
    const dir = tempDiagramDir();
    stages(dir);
    runViewDepth(1, { dir });
    applyOk(dir, {
      summary: 'add a third stage',
      ops: [
        { op: 'addGroup', group: { id: 'landing', kind: 'generic', label: 'Landing', parent: 'registry' } },
      ],
    });
    const doc = readDoc(graphFile(dir));
    // The list nobody re-set now includes the new stage, because the rule did.
    expect(doc.ok && doc.doc.collapsed).toEqual(['sources', 'pull', 'landing']);
  });

  it('an explicit list clears the rule, and then stops following new groups', () => {
    const dir = tempDiagramDir();
    stages(dir);
    runViewDepth(1, { dir });
    expect(runViewCollapsed(['sources'], { dir }).code).toBe(0);

    let doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.view).toBeUndefined();

    applyOk(dir, {
      summary: 'add a third stage',
      ops: [
        { op: 'addGroup', group: { id: 'landing', kind: 'generic', label: 'Landing', parent: 'registry' } },
      ],
    });
    doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.collapsed).toEqual(['sources']);
  });

  it('exec stores the level it chose, skipping the lone wrapper', () => {
    const dir = tempDiagramDir();
    stages(dir);
    const out = runView('exec', { dir });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('rule: depth 1');
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.collapsed).toEqual(['sources', 'pull']);
  });

  it('eng clears the rule so nothing re-collapses behind it', () => {
    const dir = tempDiagramDir();
    stages(dir);
    runViewDepth(1, { dir });
    expect(runView('eng', { dir }).code).toBe(0);
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.view).toBeUndefined();
    expect(doc.ok && doc.doc.collapsed).toEqual([]);
  });

  it('a depth past the bottom of the tree collapses nothing and is not an error', () => {
    const dir = tempDiagramDir();
    stages(dir);
    const out = runViewDepth(9, { dir });
    expect(out.code).toBe(0);
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.collapsed).toEqual([]);
    expect(doc.ok && doc.doc.view).toEqual({ depth: 9 });
  });

  it('rejects a depth that is not a whole number in range', () => {
    const dir = tempDiagramDir();
    stages(dir);
    for (const bad of [-1, 1.5, Number.NaN, 99]) {
      const out = runViewDepth(bad, { dir });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('depth must be a whole number');
    }
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.view).toBeUndefined();
  });

  it('undo puts the previous view back, rule and all', () => {
    const dir = tempDiagramDir();
    stages(dir);
    runViewDepth(0, { dir });
    runViewDepth(1, { dir });
    expect(runUndo({ dir }).code).toBe(0);
    const doc = readDoc(graphFile(dir));
    expect(doc.ok && doc.doc.view).toEqual({ depth: 0 });
    expect(doc.ok && doc.doc.collapsed).toEqual(['registry']);
  });
});

// ---------------------------------------------------------------------------
// The export is named after the document
// ---------------------------------------------------------------------------

describe('diagram export names the file after the title', () => {
  it('derives a snake_case filename from the title', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    applyOk(dir, { summary: 'name it', ops: [{ op: 'setTitle', title: 'Source Registry' }] });

    const out = await runExport({ dir, format: 'json' });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(path.join(dir, 'source_registry.json'));
    expect(fs.existsSync(path.join(dir, 'source_registry.json'))).toBe(true);
  });

  it('renames the next export when the title changes', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    applyOk(dir, { summary: 'first name', ops: [{ op: 'setTitle', title: 'Old Name' }] });
    await runExport({ dir, format: 'json' });
    applyOk(dir, { summary: 'rename', ops: [{ op: 'setTitle', title: 'New Name' }] });
    await runExport({ dir, format: 'json' });

    // The old file is left where it was: an export is a copy someone may have
    // already picked up, and a retitle must not delete it behind their back.
    expect(fs.existsSync(path.join(dir, 'old_name.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'new_name.json'))).toBe(true);
  });

  it('falls back to out.json for a document that has no name', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi); // still "Untitled"
    const out = await runExport({ dir, format: 'json' });
    expect(out.stdout).toContain(path.join(dir, DEFAULT_JSON_OUT));
    expect(fs.existsSync(path.join(dir, DEFAULT_JSON_OUT))).toBe(true);
  });

  it('never renames the store — graph.json stays where every tool looks', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    applyOk(dir, { summary: 'name it', ops: [{ op: 'setTitle', title: 'Source Registry' }] });
    expect(fs.existsSync(graphFile(dir))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'source_registry.json'))).toBe(false);
  });

  it('an explicit --out still wins', async () => {
    const dir = tempDiagramDir();
    applyOk(dir, addApi);
    applyOk(dir, { summary: 'name it', ops: [{ op: 'setTitle', title: 'Source Registry' }] });
    const chosen = path.join(dir, 'chosen.json');
    await runExport({ dir, format: 'json', out: chosen });
    expect(fs.existsSync(chosen)).toBe(true);
  });
});
