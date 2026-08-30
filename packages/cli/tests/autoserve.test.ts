// tests/autoserve.test.ts — auto-serve (spec §9.1, rules S1–S6).
//
// Every port used here is EPHEMERAL or a high random one. Nothing binds 4400:
// the machine running this suite may have a real viewer on it, and a test that
// stole that port — or worse, was satisfied by it and reported "reuse works" —
// would be measuring the developer's desktop rather than the code.
//
// Every process started here is killed in afterEach, including the ones the
// tests deliberately detach.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  autoServeSuppressed,
  ensureViewer,
  IDENTITY_PATH,
  NO_AUTOSERVE_ENV,
  pidAlive,
  probeViewer,
  readServeRecord,
  removeServeRecord,
  serveRecordPath,
  setViewerLauncher,
  VIEWER_CONTRACT,
  writeServeRecord,
  type LaunchRequest,
} from '../src/serve/autoserve.js';
import { runServe, type ServeHandle } from '../src/commands/serve.js';
import { createContext } from '../src/commands/context.js';
import { runPatchTextServing } from '../src/commands/patch.js';
import { runGet } from '../src/commands/get.js';
import { runAnalyse } from '../src/commands/analyse.js';
import { runReset } from '../src/commands/reset.js';
import { runUndoServing } from '../src/commands/undo.js';
import { callTool } from '../src/mcp/tools.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// ---------------------------------------------------------------------------
// scaffolding
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const servers: http.Server[] = [];
const handles: ServeHandle[] = [];
const children: ChildProcess[] = [];
/** pids we detached on purpose and must not leave behind. */
const detached: number[] = [];

function tmpDiagramDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoserve-'));
  dirs.push(root);
  const dir = path.join(root, '.diagram');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A high, currently-free port. Never 4400 (see the header). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** A plain HTTP server that is emphatically NOT a diagram viewer. */
async function stranger(): Promise<{ port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('I am someone else entirely\n');
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ port: typeof addr === 'object' && addr !== null ? addr.port : 0 });
    });
  });
}

/** A pid that is certainly gone: spawn something trivial and wait for it. */
async function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    c.on('exit', () => resolve(c.pid ?? 999_999));
  });
}

const seed = JSON.stringify({
  summary: 'seed',
  ops: [
    { op: 'addNode', node: { id: 'api', type: 'service', label: 'API', parent: null } },
  ],
});

/** Record every launch instead of really starting a viewer. */
function recordingLauncher(): LaunchRequest[] {
  const calls: LaunchRequest[] = [];
  setViewerLauncher((req) => {
    calls.push(req);
    // Our own pid: alive by definition, so the "starting" record that follows
    // is believed exactly as a real child's would be.
    return process.pid;
  });
  return calls;
}

beforeEach(async () => {
  // The suite-wide default is "off" (tests/setup.ts). These tests are the ones
  // that ask for the real behaviour, so they turn it back on explicitly.
  delete process.env[NO_AUTOSERVE_ENV];
  // And they point it at a high free port, never §9's 4400.
  process.env['DIAGRAM_PORT'] = String(await freePort());
});

afterEach(async () => {
  setViewerLauncher(null);
  process.env[NO_AUTOSERVE_ENV] = '1';
  delete process.env['DIAGRAM_PORT'];
  while (handles.length) await handles.pop()!.close();
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (children.length) children.pop()!.kill('SIGKILL');
  while (detached.length) {
    const pid = detached.pop()!;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. the pidfile
// ---------------------------------------------------------------------------

describe('the pidfile', () => {
  it('is written when serve binds and removed when it exits cleanly', async () => {
    const dir = tmpDiagramDir();
    const handle = await runServe({ dir, port: 0, open: false });
    handles.push(handle);

    const record = readServeRecord(dir);
    expect(record).not.toBeNull();
    expect(record!.pid).toBe(process.pid);
    expect(record!.port).toBe(handle.port);
    expect(record!.state).toBe('listening');
    expect(record!.document).toBe(path.join(dir, 'graph.json'));
    expect(record!.contract).toBe(VIEWER_CONTRACT);

    await handles.pop()!.close();
    expect(fs.existsSync(serveRecordPath(dir))).toBe(false);
  });

  it('never lands in the document', async () => {
    const dir = tmpDiagramDir();
    handles.push(await runServe({ dir, port: 0, open: false }));
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(doc)).not.toContain('port');
    expect(Object.keys(doc)).not.toContain('serve');
  });

  it('is not read as truth when it is garbage', () => {
    const dir = tmpDiagramDir();
    for (const junk of ['', 'not json', '{}', '{"pid":1}', '{"contract":"other","pid":1,"port":1,"document":"/x","state":"listening"}']) {
      fs.writeFileSync(serveRecordPath(dir), junk, 'utf8');
      expect(readServeRecord(dir)).toBeNull();
    }
  });

  it('is only removed by the process it describes', () => {
    const dir = tmpDiagramDir();
    writeServeRecord(dir, {
      contract: VIEWER_CONTRACT,
      pid: 4242,
      port: 5001,
      url: 'http://localhost:5001/',
      document: path.join(dir, 'graph.json'),
      dir,
      startedAt: Date.now(),
      state: 'listening',
    });
    removeServeRecord(dir, 999); // a different viewer's cleanup
    expect(readServeRecord(dir)).not.toBeNull();
    removeServeRecord(dir, 4242);
    expect(readServeRecord(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. the reuse check
// ---------------------------------------------------------------------------

describe('the reuse check', () => {
  it('recognises a real viewer for this document over HTTP', async () => {
    const dir = tmpDiagramDir();
    const handle = await runServe({ dir, port: 0, open: false });
    handles.push(handle);
    expect(await probeViewer(handle.port, path.join(dir, 'graph.json'))).toBe(true);
    // Same viewer, different document: not a reuse candidate.
    expect(await probeViewer(handle.port, '/somewhere/else/graph.json')).toBe(false);
  });

  it('serves its identity on the known path', async () => {
    const dir = tmpDiagramDir();
    const handle = await runServe({ dir, port: 0, open: false });
    handles.push(handle);
    const body = await new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port: handle.port, path: IDENTITY_PATH }, (res) => {
        let s = '';
        res.on('data', (c) => (s += String(c)));
        res.on('end', () => resolve(s));
      });
    });
    const id = JSON.parse(body) as Record<string, unknown>;
    expect(id['contract']).toBe(VIEWER_CONTRACT);
    expect(id['document']).toBe(path.join(dir, 'graph.json'));
    expect(id['port']).toBe(handle.port);
  });

  it('says no to a stranger on the port and to a closed port', async () => {
    const other = await stranger();
    expect(await probeViewer(other.port, '/x/graph.json')).toBe(false);
    expect(await probeViewer(await freePort(), '/x/graph.json')).toBe(false);
  });

  it('reuses a running viewer instead of starting a second (S2)', async () => {
    const dir = tmpDiagramDir();
    handles.push(await runServe({ dir, port: 0, open: false }));
    const calls = recordingLauncher();

    const result = await ensureViewer({ dir, document: path.join(dir, 'graph.json') });
    expect(result.action).toBe('reused');
    expect(calls).toHaveLength(0);
  });

  it('replaces an entry whose pid is gone, silently (S2)', async () => {
    const dir = tmpDiagramDir();
    const gone = await deadPid();
    expect(pidAlive(gone)).toBe(false);
    writeServeRecord(dir, {
      contract: VIEWER_CONTRACT,
      pid: gone,
      port: 5999,
      url: 'http://localhost:5999/',
      document: path.join(dir, 'graph.json'),
      dir,
      startedAt: Date.now(),
      state: 'listening',
    });
    const calls = recordingLauncher();

    const result = await ensureViewer({ dir, document: path.join(dir, 'graph.json') });
    expect(result.action).toBe('started');
    expect(calls).toHaveLength(1);
    // Replaced, not reported: the new record describes the new viewer.
    expect(readServeRecord(dir)!.pid).not.toBe(gone);
  });

  it('replaces an entry whose port answers something else (S2)', async () => {
    const dir = tmpDiagramDir();
    const other = await stranger();
    // A LIVE pid — this very process — so only the HTTP probe can catch this.
    writeServeRecord(dir, {
      contract: VIEWER_CONTRACT,
      pid: process.pid,
      port: other.port,
      url: `http://localhost:${other.port}/`,
      document: path.join(dir, 'graph.json'),
      dir,
      startedAt: Date.now(),
      state: 'listening',
    });
    const calls = recordingLauncher();

    const result = await ensureViewer({ dir, document: path.join(dir, 'graph.json') });
    expect(result.action).toBe('started');
    expect(calls).toHaveLength(1);
  });

  it('does not reuse a viewer serving a different document', async () => {
    const dir = tmpDiagramDir();
    const otherDir = tmpDiagramDir();
    handles.push(await runServe({ dir: otherDir, port: 0, open: false }));
    // Point dir's record at the other document's live viewer.
    const foreign = readServeRecord(otherDir)!;
    writeServeRecord(dir, { ...foreign, dir });
    const calls = recordingLauncher();

    const result = await ensureViewer({ dir, document: path.join(dir, 'graph.json') });
    expect(result.action).toBe('started');
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. the hook: which commands fire it (S1)
// ---------------------------------------------------------------------------

describe('the hook (S1)', () => {
  it('starts a viewer on the patch that first draws something', async () => {
    const dir = tmpDiagramDir();
    const calls = recordingLauncher();
    const out = await runPatchTextServing(seed, 'test', { dir });

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.dir).toBe(dir);
    // Told once, terse, in the §4.1 voice.
    const lines = out.text.split('\n');
    expect(lines[lines.length - 1]).toMatch(/^viewer: started at http:\/\/localhost:\d+\/$/);
    expect(out.text.split('viewer: started')).toHaveLength(2);
  });

  it('starts ONE viewer for two patches in a row (S2)', async () => {
    const dir = tmpDiagramDir();
    const calls = recordingLauncher();

    const first = await runPatchTextServing(seed, 'test', { dir });
    const second = await runPatchTextServing(
      JSON.stringify({
        summary: 'more',
        ops: [{ op: 'addNode', node: { id: 'db', type: 'database', label: 'DB', parent: null } }],
      }),
      'test',
      { dir },
    );

    expect(calls).toHaveLength(1);
    expect(first.text).toContain('viewer: started');
    // S6, said in text: the second patch neither starts nor announces anything.
    expect(second.text).not.toContain('viewer:');
  });

  it('starts nothing on a rejected patch', async () => {
    const dir = tmpDiagramDir();
    const calls = recordingLauncher();
    const out = await runPatchTextServing(
      JSON.stringify({
        summary: 'bad',
        ops: [{ op: 'addEdge', edge: { id: 'e1', from: 'nope', to: 'also-nope', style: 'solid' } }],
      }),
      'test',
      { dir },
    );

    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(serveRecordPath(dir))).toBe(false);
  });

  it('starts nothing on a patch that changes nothing', async () => {
    const dir = tmpDiagramDir();
    setViewerLauncher(() => process.pid);
    await runPatchTextServing(seed, 'test', { dir, noServe: true });
    const calls = recordingLauncher();

    // Re-sending the same addNode coerces to an updateNode that changes no field.
    const out = await runPatchTextServing(seed, 'test', { dir });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('starts nothing on a read', async () => {
    const dir = tmpDiagramDir();
    await runPatchTextServing(seed, 'test', { dir, noServe: true });
    const calls = recordingLauncher();

    runGet({ dir });
    runAnalyse({ dir });

    expect(calls).toHaveLength(0);
    expect(fs.existsSync(serveRecordPath(dir))).toBe(false);
  });

  it('starts nothing for reset — there is nothing left to show', async () => {
    const dir = tmpDiagramDir();
    await runPatchTextServing(seed, 'test', { dir, noServe: true });
    const calls = recordingLauncher();

    expect(runReset({ dir, confirm: true }).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('starts a viewer for the undo that brings a diagram back', async () => {
    const dir = tmpDiagramDir();
    await runPatchTextServing(seed, 'test', { dir, noServe: true });
    expect(runReset({ dir, confirm: true }).ok).toBe(true);
    const calls = recordingLauncher();

    const out = await runUndoServing({ dir });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(out.text).toContain('viewer: started at');
  });

  it('starts nothing for a patch that leaves the page empty', async () => {
    const dir = tmpDiagramDir();
    const calls = recordingLauncher();
    const out = await runPatchTextServing(
      JSON.stringify({ summary: 'title only', ops: [{ op: 'setTitle', title: 'Checkout' }] }),
      'test',
      { dir },
    );
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('says the same thing through the MCP tool as through the CLI', async () => {
    const cliDir = tmpDiagramDir();
    const mcpDir = tmpDiagramDir();
    const calls = recordingLauncher();

    const cli = await runPatchTextServing(seed, 'test', { dir: cliDir });
    const mcp = await callTool(
      'diagram_patch',
      JSON.parse(seed) as Record<string, unknown>,
      createContext({ dir: mcpDir }),
    );

    expect(calls).toHaveLength(2);
    const strip = (t: string) => t.replace(/localhost:\d+/, 'localhost:PORT');
    expect(strip(mcp.text)).toBe(strip(cli.text));
    expect(mcp.text).toContain('viewer: started at');
  });
});

// ---------------------------------------------------------------------------
// 4. the opt-out (S5)
// ---------------------------------------------------------------------------

describe('the opt-out (S5)', () => {
  it('reads the environment variable, and only as an affirmative', () => {
    const cases: [string | undefined, boolean][] = [
      [undefined, false],
      ['', false],
      ['0', false],
      ['false', false],
      ['no', false],
      ['1', true],
      ['true', true],
      ['yes', true],
    ];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env[NO_AUTOSERVE_ENV];
      else process.env[NO_AUTOSERVE_ENV] = value;
      expect(autoServeSuppressed()).toBe(expected);
    }
    delete process.env[NO_AUTOSERVE_ENV];
    expect(autoServeSuppressed(true)).toBe(true);
  });

  it('suppresses the spawn by environment variable', async () => {
    const dir = tmpDiagramDir();
    const calls = recordingLauncher();
    process.env[NO_AUTOSERVE_ENV] = '1';

    const out = await runPatchTextServing(seed, 'test', { dir });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(out.text).not.toContain('viewer:');
    expect(fs.existsSync(serveRecordPath(dir))).toBe(false);
  });

  it('suppresses the spawn by --no-serve, with the variable unset', async () => {
    const dir = tmpDiagramDir();
    const calls = recordingLauncher();

    const out = await runPatchTextServing(seed, 'test', { dir, noServe: true });
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(out.text).not.toContain('viewer:');
  });

  it('registers --no-serve on every command that can auto-serve', () => {
    // Registration, checked at the source: booting the whole commander program
    // to read four help texts tests commander, not us. The behaviour behind
    // the flag is covered by the test above, which drives noServe directly.
    for (const file of ['patch.ts', 'import.ts', 'undo.ts', 'redo.ts']) {
      const src = fs.readFileSync(path.join(REPO, 'packages/cli/src/commands', file), 'utf8');
      expect(src).toContain("'--no-serve'");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. THE GUARD THAT MATTERS: the eval harness keeps the opt-out (S5)
// ---------------------------------------------------------------------------

describe('the M8 eval harness (S5)', () => {
  // If this fails, do not "fix" it by deleting the test. `scripts/eval.sh`
  // runs up to twenty sandboxed patches per system, four at a time. Without
  // the export, each one starts a detached server holding a port and opens a
  // browser tab, on the machine that is meant to be producing a timing
  // benchmark. The damage is invisible until someone runs a 20-run eval.
  const script = () => fs.readFileSync(path.join(REPO, 'scripts', 'eval.sh'), 'utf8');

  it('exports DIAGRAM_NO_AUTOSERVE=1', () => {
    expect(script()).toMatch(/^export DIAGRAM_NO_AUTOSERVE=1$/m);
  });

  it('exports it before it ever launches an agent', () => {
    const s = script();
    const exported = s.indexOf('\nexport DIAGRAM_NO_AUTOSERVE=1');
    const agent = s.indexOf('DEFAULT_AGENT_BIN" -p');
    expect(exported).toBeGreaterThan(-1);
    expect(agent).toBeGreaterThan(-1);
    expect(exported).toBeLessThan(agent);
  });

  it('never unsets it in the scrubbed agent environment', () => {
    // The rig deliberately unsets everything that could vary between machines.
    // DIAGRAM_NO_AUTOSERVE must not join that list.
    const unset = script().match(/^\s*unset [^\n]*(\n\s+[A-Z_ ]+\\?)*/gm) ?? [];
    for (const block of unset) expect(block).not.toContain('DIAGRAM_NO_AUTOSERVE');
  });
});

// ---------------------------------------------------------------------------
// 6. `diagram init` gitignores the pidfile
// ---------------------------------------------------------------------------

describe('diagram init', () => {
  it('gitignores .diagram/serve.json', async () => {
    const { runInit } = await import('../src/commands/init.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoserve-init-'));
    dirs.push(root);
    runInit({ root });
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain(
      '.diagram/serve.json',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. S3 — the child really outlives its parent
// ---------------------------------------------------------------------------

describe('detachment (S3)', () => {
  it('a child spawned this way survives its parent exiting', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autoserve-detach-')), 'pid');
    dirs.push(path.dirname(marker));

    // The grandchild: stays up doing nothing until it is killed.
    const grandchild = 'setInterval(() => {}, 1000)';
    // The parent: spawns it with the exact option triple spawnViewer uses,
    // records the pid, and exits immediately.
    const parent = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const c = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],
        { detached: true, stdio: 'ignore' });
      c.unref();
      fs.writeFileSync(${JSON.stringify(marker)}, String(c.pid));
    `;

    const code = await new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ['-e', parent], { stdio: 'ignore' });
      p.on('exit', (c) => resolve(c ?? 1));
    });
    expect(code).toBe(0);

    const pid = Number.parseInt(fs.readFileSync(marker, 'utf8'), 10);
    detached.push(pid);
    // The parent has exited (we waited for it). The grandchild has not.
    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(pid)).toBe(true);
  });

  it('end to end: a real `diagram patch` leaves a viewer running behind it', async () => {
    const built = path.join(REPO, 'packages/cli/dist/bin/diagram.js');
    if (!fs.existsSync(built)) {
      // `npm run build` has not run in this tree. The mechanism is covered by
      // the test above; this one needs the binary auto-serve actually spawns.
      expect(fs.existsSync(built)).toBe(false);
      return;
    }
    const dir = tmpDiagramDir();
    const port = await freePort();
    const patchFile = path.join(path.dirname(dir), 'patch.json');
    fs.writeFileSync(patchFile, seed, 'utf8');

    // A REAL CLI process, which exits. Anything it started that is still alive
    // afterwards is genuinely detached.
    const out = await new Promise<{ code: number; text: string }>((resolve) => {
      const p = spawn(
        process.execPath,
        [built, 'patch', '--file', patchFile, '--dir', dir],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            DIAGRAM_PORT: String(port),
            DIAGRAM_NO_AUTOSERVE: '',
            // Headless: the point of this test is the process tree, not a tab.
            DIAGRAM_NO_OPEN: '1',
          },
        },
      );
      let text = '';
      p.stdout.on('data', (c) => (text += String(c)));
      p.stderr.on('data', (c) => (text += String(c)));
      p.on('exit', (code) => resolve({ code: code ?? 1, text }));
    });

    expect(out.code).toBe(0);
    expect(out.text).toContain('viewer: started at');

    const record = readServeRecord(dir);
    expect(record).not.toBeNull();
    detached.push(record!.pid);

    // Give the detached viewer a moment to bind, then ask it who it is. Its
    // parent — the patch process — is long gone.
    let alive = false;
    for (let i = 0; i < 60 && !alive; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      alive = await probeViewer(record!.port, path.join(dir, 'graph.json'), 500);
    }
    expect(alive).toBe(true);
    expect(pidAlive(record!.pid)).toBe(true);
    expect(record!.pid).not.toBe(process.pid);
  }, 30_000);
});
