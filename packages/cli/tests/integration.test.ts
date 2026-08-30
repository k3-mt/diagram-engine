// tests/integration.test.ts — the M6 wiring itself (spec §4.1, §4.2).
//
// The command modules and the MCP tools each have their own tests. This file
// tests the seams between them, which is where an integration actually breaks:
//
//   1. every command is registered on the `diagram` program, and says what it
//      does in `--help`;
//   2. `--dir` means the same thing on every command that takes it — and init,
//      which means something else, does not call it `--dir`;
//   3. the CLI and the MCP tool for the same operation return byte-identical
//      text, because they run one body. Assert on the strings, not on the call
//      graph: sharing a function today is worth nothing if a later edit adds a
//      second renderer.
//   4. both binaries are declared and both shims are emitted.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphPatch } from '../../core/src/index.js';
import { buildProgram } from '../src/bin/diagram.js';
import { createContext, type DiagramContext } from '../src/commands/context.js';
import { runAnalyse } from '../src/commands/analyse.js';
import { runGet } from '../src/commands/get.js';
import { runPatchText } from '../src/commands/patch.js';
import { runExport } from '../src/commands/export.js';
import { runView, runViewCollapsed } from '../src/commands/view.js';
import { runUndo } from '../src/commands/undo.js';
import { callTool, TOOL_NAMES } from '../src/mcp/tools.js';

const cleanups: Array<() => void> = [];
const savedEnv = process.env['DIAGRAM_DIR'];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  if (savedEnv === undefined) delete process.env['DIAGRAM_DIR'];
  else process.env['DIAGRAM_DIR'] = savedEnv;
});

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempContext(): DiagramContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-integration-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return createContext({ dir: path.join(root, '.diagram') });
}

const seedPatch: GraphPatch = {
  ops: [
    { op: 'addGroup', group: { id: 'vpc', label: 'VPC', kind: 'vpc', parent: null } },
    { op: 'addNode', node: { id: 'api', label: 'API', type: 'service', parent: 'vpc' } },
    { op: 'addNode', node: { id: 'db', label: 'DB', type: 'database', parent: 'vpc' } },
    { op: 'addEdge', edge: { id: 'e1', from: 'api', to: 'db', label: 'reads', style: 'solid' } },
  ],
  summary: 'seed',
};

/** A context holding a small real diagram, written through the shared spine. */
async function seeded(): Promise<DiagramContext> {
  const ctx = tempContext();
  const out = runPatchText(JSON.stringify(seedPatch), 'test', { dir: ctx.dir });
  expect(out.stderr).toBe('');
  return ctx;
}

describe('the diagram program', () => {
  const commands = buildProgram().commands;
  const names = commands.map((c) => c.name());

  it('registers every command, in help order', async () => {
    expect(names).toEqual([
      'init',
      'get',
      'patch',
      'undo',
      'redo',
      'view',
      'serve',
      'export',
      'import',
      'check',
      'analyse',
      'blast-radius',
      'rules',
      'mcp',
      'reset',
    ]);
  });

  it('gives each command a one-line description for --help', async () => {
    for (const command of commands) {
      const description = command.description();
      expect(description, command.name()).not.toBe('');
      // One line: `diagram --help` puts these in a column.
      expect(description, command.name()).not.toContain('\n');
    }
  });

  it('uses --dir for the .diagram directory everywhere except init', async () => {
    for (const command of commands) {
      const flags = command.options.map((o) => o.long);
      if (command.name() === 'init') {
        // init installs across the whole project, so its directory is the
        // project root — a different thing, and therefore a different flag.
        expect(flags).toContain('--root');
        expect(flags).not.toContain('--dir');
        continue;
      }
      if (command.name() === 'rules') continue; // reads no document at all
      expect(flags, command.name()).toContain('--dir');
      const dir = command.options.find((o) => o.long === '--dir');
      expect(dir?.description, command.name()).toContain('.diagram');
    }
  });
});

describe('the CLI and the MCP tools are one implementation', () => {
  it('advertises the tools of spec §4.1 and §15.4', async () => {
    expect(TOOL_NAMES).toEqual([
      'diagram_get',
      'diagram_patch',
      'diagram_undo',
      'diagram_redo',
      'diagram_view',
      'diagram_export',
      'diagram_analyse',
      'diagram_blast_radius',
      'diagram_reset',
    ]);
  });

  it('reads the same table through `diagram get` and diagram_get', async () => {
    const ctx = await seeded();
    expect((await callTool('diagram_get', {}, ctx)).text).toBe(runGet({ dir: ctx.dir }).text);
  });

  it('analyses through `diagram analyse` and diagram_analyse identically', async () => {
    const ctx = await seeded();
    const viaTool = await callTool('diagram_analyse', {}, ctx);
    expect(viaTool.ok).toBe(true);
    expect(viaTool.text).toBe(runAnalyse({ dir: ctx.dir }).text);
    // A2 and A5 on both surfaces at once: the coverage block is not something
    // one of the two renderers may drop.
    expect(viaTool.text).toContain('scope: full document');
    expect(viaTool.text).toContain('carry no operational meta');
  });

  it('says the same thing about a project with no diagram on both analyse surfaces', async () => {
    const ctx = tempContext();
    expect((await callTool('diagram_analyse', {}, ctx)).text).toBe(runAnalyse({ dir: ctx.dir }).text);
  });

  it('says the same thing about an empty project on both surfaces', async () => {
    const ctx = tempContext();
    expect((await callTool('diagram_get', {}, ctx)).text).toBe(runGet({ dir: ctx.dir }).text);
  });

  it('sets a view with the same lines on both surfaces', async () => {
    const viaTool = (await callTool('diagram_view', { preset: 'exec' }, await seeded())).text;
    const viaCli = runView('exec', { dir: (await seeded()).dir }).text;
    expect(viaTool).toBe(viaCli);
    // Three result lines and no fourth: the M7 caveat is gone now that the
    // viewer and `export svg` both honour collapsed, and it has to disappear
    // from both surfaces at once or neither.
    expect(viaTool.split('\n')).toHaveLength(3);
  });

  it('sets an explicit collapsed list identically on both surfaces', async () => {
    const viaTool = await callTool('diagram_view', { collapsed: ['vpc'] }, await seeded());
    const viaCli = runViewCollapsed(['vpc'], { dir: (await seeded()).dir });
    expect(viaTool.text).toBe(viaCli.text);
    expect(viaTool.ok).toBe(true);

    const badTool = await callTool('diagram_view', { collapsed: ['ghost'] }, await seeded());
    const badCli = runViewCollapsed(['ghost'], { dir: (await seeded()).dir });
    expect(badTool.text).toBe(badCli.text);
    expect(badCli.ok).toBe(false);
  });

  it('rejects an unknown focus group identically on both surfaces', async () => {
    const viaTool = await callTool('diagram_view', { preset: 'focus', id: 'ghost' }, await seeded());
    const viaCli = runView('focus', { dir: (await seeded()).dir, id: 'ghost' });
    expect(viaTool.ok).toBe(false);
    expect(viaTool.text).toBe(viaCli.text);
    expect(viaTool.text).toContain('Existing groups: vpc');
  });

  it('exports to the same default path with the same wording', async () => {
    const forTool = await seeded();
    const forCli = await seeded();
    const viaTool = await callTool('diagram_export', { format: 'json' }, forTool);
    const viaCli = await runExport({ dir: forCli.dir });
    expect(viaTool.ok).toBe(true);
    // Same file name, in each one's own .diagram/ — so only the temp root differs.
    expect(viaTool.text.replace(forTool.dir, '<dir>')).toBe(
      viaCli.text.replace(forCli.dir, '<dir>'),
    );
    expect(fs.existsSync(path.join(forTool.dir, 'out.json'))).toBe(true);
    // One dispatcher, so a second call is the same call: json cannot grow a
    // second implementation behind a second entry point.
    expect((await callTool('diagram_export', { format: 'json' }, forTool)).text).toBe(viaTool.text);
  });

  it('exports the same svg, of the same view, on both surfaces', async () => {
    // The real headless renderer on both sides. What is under test is that
    // the two surfaces agree about WHICH document is drawn and what the
    // result says — so the assertion is that the two files are byte-equal.
    const forTool = await seeded();
    const forCli = await seeded();
    expect(runViewCollapsed(['vpc'], { dir: forTool.dir }).ok).toBe(true);
    expect(runViewCollapsed(['vpc'], { dir: forCli.dir }).ok).toBe(true);

    const viaTool = await callTool('diagram_export', { format: 'svg' }, forTool);
    const viaCli = await runExport({ dir: forCli.dir, format: 'svg' });
    expect(viaTool.ok).toBe(true);
    expect(viaTool.text.replace(forTool.dir, '<dir>')).toBe(
      viaCli.text.replace(forCli.dir, '<dir>'),
    );
    // Collapsed by default on BOTH surfaces: vpc's two nodes became one.
    expect(viaTool.text).toContain('view: collapsed vpc');
    const collapsedSvg = fs.readFileSync(path.join(forTool.dir, 'out.svg'), 'utf8');
    expect(collapsedSvg).toBe(fs.readFileSync(path.join(forCli.dir, 'out.svg'), 'utf8'));
    expect(collapsedSvg).toContain('data-node="vpc"');
    expect(collapsedSvg).not.toContain('data-node="api"');

    const fullTool = await callTool(
      'diagram_export',
      { format: 'svg', full: true },
      forTool,
    );
    const fullCli = await runExport({ dir: forCli.dir, format: 'svg', full: true });
    expect(fullTool.text.replace(forTool.dir, '<dir>')).toBe(
      fullCli.text.replace(forCli.dir, '<dir>'),
    );
    expect(fullTool.text).toContain('view: full graph (--full)');
    const fullSvg = fs.readFileSync(path.join(forTool.dir, 'out.svg'), 'utf8');
    expect(fullSvg).toBe(fs.readFileSync(path.join(forCli.dir, 'out.svg'), 'utf8'));
    expect(fullSvg).toContain('data-node="api"');
  });

  it('refuses png identically on both surfaces', async () => {
    const viaTool = await callTool('diagram_export', { format: 'png' }, await seeded());
    const viaCli = await runExport({ dir: (await seeded()).dir, format: 'png' });
    expect(viaTool.ok).toBe(false);
    expect(viaTool.text).toBe(viaCli.text);
    expect(viaTool.text).toContain('diagram serve');
  });

  it('undoes with the same result text on both surfaces', async () => {
    const forTool = await seeded();
    const forCli = await seeded();
    expect((await callTool('diagram_undo', {}, forTool)).text).toBe(runUndo({ dir: forCli.dir }).text);
  });

  it('carries the ok/code/stdout/stderr shape on a tool result too', async () => {
    // One output type across both surfaces: the MCP result IS a CommandOutput,
    // which is what stops a second renderer appearing on either side.
    const result = await callTool('diagram_get', {}, await seeded());
    expect(result).toMatchObject({ ok: true, code: 0, stderr: '' });
    expect(result.stdout).toBe(result.text);
  });
});

describe('the package declares both binaries', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
  ) as { bin: Record<string, string> };

  it('maps diagram and diagram-mcp to stable dist/bin paths', async () => {
    expect(pkg.bin).toEqual({
      diagram: 'dist/bin/diagram.js',
      'diagram-mcp': 'dist/bin/diagram-mcp.js',
    });
  });

  it('has a source entry point for every declared binary', async () => {
    for (const name of Object.keys(pkg.bin)) {
      expect(fs.existsSync(path.join(pkgRoot, 'src', 'bin', `${name}.ts`)), name).toBe(true);
    }
  });
});

describe('a rejection tells the agent what the valid ids are', () => {
  const badEdge: GraphPatch = {
    ops: [
      { op: 'addEdge', edge: { id: 'e9', from: 'api', to: 'redis', label: 'caches', style: 'dashed' } },
    ],
    summary: 'add caching',
  };

  it('lists the known node ids and applies nothing', async () => {
    const ctx = await seeded();
    const before = fs.readFileSync(ctx.paths.graphFile);
    const out = runPatchText(JSON.stringify(badEdge), 'test', { dir: ctx.dir });

    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('rejected — no changes applied');
    expect(out.stderr).toContain('unknown node "redis"');
    // The point: an invented id has no near match, so without this line the
    // agent has to call diagram_get before it can even retry.
    expect(out.stderr).toContain('known node ids: api, db');
    // Byte-identical, as Buffers — the atomicity promise the retry rests on.
    expect(fs.readFileSync(ctx.paths.graphFile).equals(before)).toBe(true);
  });

  it('says the same thing through diagram_patch', async () => {
    const viaTool = await callTool('diagram_patch', badEdge as unknown as Record<string, unknown>, await seeded());
    const viaCli = runPatchText(JSON.stringify(badEdge), 'test', { dir: (await seeded()).dir });
    expect(viaTool.ok).toBe(false);
    expect(viaTool.text).toBe(viaCli.text);
  });

  it('does not attach the roster to a rejection that is not about ids', async () => {
    const ctx = await seeded();
    const out = runPatchText(
      JSON.stringify({ ops: [{ op: 'setDirection', direction: 'SIDEWAYS' }], summary: 'x' }),
      'test',
      { dir: ctx.dir },
    );
    expect(out.code).toBe(1);
    expect(out.stderr).not.toContain('known node ids');
  });
});

// ---------------------------------------------------------------------------
// The compiled tree must actually run (M7)
// ---------------------------------------------------------------------------
//
// `diagram export svg` reaches across a package boundary into the viewer's
// headless renderer, and the two ways that can break are both INVISIBLE to
// every other test in this repo, because vitest resolves modules the way
// vite does and the built binary resolves them the way Node does:
//
//   * a relative specifier with no `.js` — fine under bundler resolution,
//     "Cannot find module" under Node ESM;
//   * a VALUE import of '@diagram-engine/core' — fine under bundler
//     resolution, but it survives compilation verbatim and Node then follows
//     the workspace link to a package whose "main" is a .ts file.
//
// Either one turns `export svg` into "not available in this build" in the
// binary while the whole suite stays green. So this walks the static import
// graph tsc actually compiles — from each binary, through relative edges
// only — and checks both invariants at the source, with no build required.

const SRC_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Comment lines, dropped before scanning. These files explain their own
 * import rules IN PROSE, quoting the specifiers they are talking about, so a
 * scanner that reads comments reports the documentation as a violation.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

/** Every import/export specifier in a module, with whether it is type-only. */
function specifiers(source: string): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  const re = /\b(import|export)\s+(type\s+)?([^;'"]*?)from\s*['"]([^'"]+)['"]/g;
  for (const m of stripComments(source).matchAll(re)) {
    const clause = m[3] ?? '';
    // `import type X from` and `import { type X, type Y } from` are both
    // erased; a clause mixing values and types is not.
    const typeOnly =
      m[2] !== undefined ||
      (/\{[^}]*\}/.test(clause) &&
        clause
          .replace(/^[^{]*\{|\}[^}]*$/g, '')
          .split(',')
          .filter((s) => s.trim() !== '')
          .every((s) => s.trim().startsWith('type ')));
    out.push({ spec: m[4] as string, typeOnly });
  }
  // A bare side-effect import ('...') has no `from`, and none exist here.
  return out;
}

/** Resolve a relative specifier back to the .ts/.tsx file tsc will compile. */
function resolveSource(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

describe('the compiled binary can resolve everything it imports', () => {
  const entries = [
    path.join(SRC_ROOT, 'cli', 'src', 'bin', 'diagram.ts'),
    path.join(SRC_ROOT, 'cli', 'src', 'bin', 'diagram-mcp.ts'),
  ];
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(SRC_ROOT, file);
    for (const { spec, typeOnly } of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        if (!spec.endsWith('.js') && !spec.endsWith('.json')) {
          problems.push(`${rel}: relative import "${spec}" has no .js extension`);
          continue;
        }
        if (spec.endsWith('.json')) continue;
        const target = resolveSource(file, spec);
        if (target === null) problems.push(`${rel}: "${spec}" resolves to no source file`);
        else queue.push(target);
      } else if (spec.startsWith('@diagram-engine/') && !typeOnly) {
        problems.push(`${rel}: value import of "${spec}" — use a relative path`);
      }
    }
  }

  it('reaches the viewer headless renderer at all', () => {
    // If this ever stops being true, `export svg` has quietly gone back to
    // being unwired and the checks below would pass vacuously.
    expect([...seen].some((f) => f.endsWith(path.join('viewer', 'src', 'export', 'toSvg.ts')))).toBe(
      true,
    );
    expect(seen.size).toBeGreaterThan(30);
  });

  it('imports nothing Node cannot resolve from dist/', () => {
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The sources stay TEXT
// ---------------------------------------------------------------------------
//
// A raw NUL byte inside a string literal (the house idiom for a map-key
// separator, `${from}\x00${to}`) is legal TypeScript and runs identically to
// the escape — but it makes the FILE binary. `file` reports it as `data`, and
// grep silently prints nothing for it: `grep -rn deriveView packages/core/`
// skipped the file that DEFINES deriveView, and `grep -n resolvePreset` on
// viewState.ts returned nothing for a file that plainly imports it. In a repo
// whose premise is that an agent reads and edits it from a terminal, a source
// file invisible to grep is a trap, and it is how the collapsed-key split bug
// survived review. The escape sequence is byte-identical at runtime, so there
// is no reason ever to embed the byte.

describe('no source file is binary to grep', () => {
  const suspect: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|md|json)$/.test(entry.name)) continue;
      const bytes = fs.readFileSync(full);
      for (const b of bytes) {
        // Everything below 0x09 is a control byte no source needs; grep
        // treats a file containing one as binary.
        if (b < 0x09) {
          suspect.push(path.relative(SRC_ROOT, full));
          break;
        }
      }
    }
  };
  walk(SRC_ROOT);

  it('contains no control bytes below 0x09 in any tracked source', () => {
    expect(suspect).toEqual([]);
  });
});
