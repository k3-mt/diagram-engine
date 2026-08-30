// serve/autoserve.ts — auto-serve (spec §9.1, rules S1–S6).
//
// THE GAP. A first session says "draw our architecture". The agent patches the
// document correctly and nothing appears, because `diagram serve` was never
// started. The agent then says "run `diagram serve` to see it" — after the
// fact. The tool worked and the user saw a blank terminal. So a write that
// leaves content on the page starts the viewer, if one is not already up.
//
// This module owns three things and nothing else:
//
//   1. THE PIDFILE (.diagram/serve.json) — a HINT about a viewer, never a
//      fact. It is written by `diagram serve` when it binds and removed when
//      it exits cleanly, which means a `kill -9`, a reboot, or a crash leaves
//      a lie behind. Every read is therefore re-verified (see isLive).
//   2. THE DETACHED SPAWN — its own session, no inherited stdio, unref()ed, so
//      the MCP process can exit and the diagram stays on screen (S3, §2.1).
//   3. THE DECISION — reuse, start, or do nothing, with the opt-out honoured
//      first so `DIAGRAM_NO_AUTOSERVE=1` costs nothing at all (S5).
//
// WHAT IT IS NOT. It is not document state. serve.json lives beside graph.json
// but is gitignored and never touched by the schema: §1.4 forbids geometry in
// the document, and a port number is exactly the kind of machine-local fact
// that must not travel in a commit.
//
// Runtime import of core by relative path: see the note in commands/patch.ts.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  IDENTITY_PATH,
  PORT_ATTEMPTS,
  SERVE_HOST,
  VIEWER_CONTRACT,
} from './http.js';

// Re-exported so the pidfile's two constants read from one place at the call
// sites that care (commands/serve.ts writes them, this module verifies them).
export { IDENTITY_PATH, VIEWER_CONTRACT };

// ---------------------------------------------------------------------------
// The pidfile
// ---------------------------------------------------------------------------

/** The pidfile's name inside .diagram/. `diagram init` gitignores it. */
export const SERVE_RECORD_FILE = 'serve.json';

/** What a viewer records about itself, and answers on IDENTITY_PATH. */
export interface ServeRecord {
  /** VIEWER_CONTRACT. A record without it is not ours; it is replaced. */
  contract: string;
  /** The viewer process id. */
  pid: number;
  /** The bound port — or, while `state` is "starting", the requested one. */
  port: number;
  /** The browser URL, http://localhost:<port>/. */
  url: string;
  /** Absolute path of the graph.json this viewer serves. */
  document: string;
  /** Absolute path of the .diagram directory. */
  dir: string;
  /** Date.now() when this record was written. */
  startedAt: number;
  /**
   * "starting" is written by the SPAWNER between fork and bind; the viewer
   * overwrites it with "listening" once the socket is up. Without that state
   * two patches 5ms apart would both find no listener and start two viewers —
   * the one bug S2 exists to prevent.
   */
  state: 'starting' | 'listening';
}

/**
 * How long a "starting" record is believed once the identity probe has already
 * said no.
 *
 * A viewer binds in ~200ms on this machine, so this is generous by more than
 * an order of magnitude. It is deliberately not longer: every millisecond of
 * it is a window in which a child that died during startup is still believed,
 * and a believed-but-absent viewer is the silent blank terminal §9.1 exists to
 * abolish. Bounded by a probe on the way in (see isLive) and by this on the
 * way out.
 */
export const STARTUP_GRACE_MS = 5_000;

/** Hard cap on the identity probe. A localhost round trip is ~1ms; this is a
 *  ceiling that keeps G6's 400ms budget intact even when the machine stalls. */
export const PROBE_TIMEOUT_MS = 250;

/** The pidfile path for a .diagram directory. */
export function serveRecordPath(dir: string): string {
  return path.join(dir, SERVE_RECORD_FILE);
}

/**
 * Read the pidfile, or null.
 *
 * Every failure mode — absent, truncated, not JSON, wrong shape, wrong
 * contract — returns null rather than throwing. A stale or malformed entry is
 * not a user error and must never surface as one (§9.1: "replaced, not
 * reported"): the user did nothing wrong, and the fix is to start a viewer.
 */
export function readServeRecord(dir: string): ServeRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(serveRecordPath(dir), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Partial<ServeRecord>;
  if (r.contract !== VIEWER_CONTRACT) return null;
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null;
  if (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port <= 0) return null;
  if (typeof r.document !== 'string' || r.document === '') return null;
  if (r.state !== 'starting' && r.state !== 'listening') return null;
  return {
    contract: VIEWER_CONTRACT,
    pid: r.pid,
    port: r.port,
    url: typeof r.url === 'string' ? r.url : `http://localhost:${r.port}/`,
    document: r.document,
    dir: typeof r.dir === 'string' ? r.dir : dir,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
    state: r.state,
  };
}

/**
 * What a claim attempt did.
 *
 * `unwritable` is not a failure to act on: a viewer that cannot record itself
 * still serves, and the cost is only that the next patch may start a second
 * one. Refusing to draw because a directory is read-only would be worse.
 */
export type ClaimOutcome = 'claimed' | 'taken' | 'unwritable';

/**
 * Claim the right to start a viewer for this directory — atomically.
 *
 * This is the whole of S2's mutual exclusion, and it has to be one syscall.
 * The sequence it replaces (read the record, see nothing, scan for a port,
 * spawn, THEN write the record) has an await in the middle of it, so two
 * calls that overlap anywhere in that window both conclude "no viewer here"
 * and both spawn one. Two viewers for one document is the bug S2 names.
 *
 * `wx` is O_EXCL: the file is created only if it does not exist, and the
 * kernel decides the winner. The loser gets EEXIST, re-reads, and reuses what
 * the winner is starting. Separate PROCESSES are additionally serialised by
 * the store lock in applyAndCommit; the case only this closes is two
 * overlapping calls inside ONE process, which is the MCP server whenever a
 * client has two diagram_patch calls in flight.
 */
export function claimStart(dir: string, record: ServeRecord): ClaimOutcome {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(serveRecordPath(dir), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return 'claimed';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'taken' : 'unwritable';
  }
}

/** Write the pidfile. tmp+rename so a concurrent reader never sees half of it. */
export function writeServeRecord(dir: string, record: ServeRecord): void {
  const file = serveRecordPath(dir);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // A viewer that cannot record itself still serves. The cost is that the
    // next patch may start a second one, which is far better than refusing to
    // start the first.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing left to do */
    }
  }
}

/**
 * Remove the pidfile — but only if it still describes `pid`.
 *
 * The guard matters on a race: viewer A exits at the moment viewer B (started
 * for the same directory by a patch that ran a millisecond earlier) writes its
 * own record. An unguarded delete would erase B's record and the patch after
 * that would start a third viewer.
 */
export function removeServeRecord(dir: string, pid?: number): void {
  if (pid !== undefined) {
    const current = readServeRecord(dir);
    if (current !== null && current.pid !== pid) return;
  }
  try {
    fs.rmSync(serveRecordPath(dir), { force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Is that viewer real?
// ---------------------------------------------------------------------------

/**
 * Does a process with this pid exist? Signal 0 checks without delivering.
 *
 * EPERM means it exists and belongs to someone else, which still counts as
 * alive; only ESRCH is "gone". This is the cheap half of the check — it costs
 * a syscall — and it is deliberately not the whole of it, because pids are
 * recycled and a reboot can hand ours to something unrelated.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ask whatever is on `port` whether it is OUR viewer for THIS document.
 *
 * Resolves false for every negative answer — refused connection, timeout,
 * non-200, unparseable body, wrong contract, a viewer serving a different
 * document — because they all lead to the same action: start a viewer.
 */
export async function probeViewer(
  port: number,
  document: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    const req = http.request(
      { host: SERVE_HOST, port, path: IDENTITY_PATH, method: 'GET', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(false);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          // A stranger on this port could stream forever; 64KB is far more
          // than the identity document and bounds the probe's memory.
          if (size > 64 * 1024) {
            res.destroy();
            done(false);
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<ServeRecord>;
            done(body.contract === VIEWER_CONTRACT && body.document === document);
          } catch {
            done(false);
          }
        });
        res.on('error', () => done(false));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}

/**
 * Is the recorded viewer genuinely serving this document?
 *
 * Two gates in cost order. The pid check is a syscall and rules out the common
 * case (the machine rebooted, the viewer was killed). The HTTP probe is the
 * authoritative one and only runs when the pid check passed.
 *
 * The probe runs FIRST in every state, including "starting". An earlier draft
 * short-circuited a fresh "starting" record on the pid check alone, on the
 * argument that the child has not bound yet so the probe must fail. The
 * argument is right about the common case and wrong about the consequence:
 * pids are recycled, so a child that died during startup whose pid landed on
 * some unrelated live process was believed for the whole window, and every
 * patch in it printed nothing and showed nothing. That is the blank terminal
 * again, in miniature. Asking the port first costs an immediate connection
 * refusal (~1ms — nothing is listening, so there is nothing to wait for) and
 * removes the pid as a sole source of truth.
 *
 * The grace window is only the fallback AFTER the probe has said no, which is
 * exactly the "spawned, not bound yet" case it was written for. It also
 * covers the child that auto-incremented past our requested port: it will
 * overwrite this record with the port it really bound, and until it does, the
 * window keeps a second viewer from being started underneath it.
 */
export async function isLive(record: ServeRecord, document: string): Promise<boolean> {
  if (record.document !== document) return false;
  if (!pidAlive(record.pid)) return false;
  if (await probeViewer(record.port, document)) return true;
  return record.state === 'starting' && Date.now() - record.startedAt < STARTUP_GRACE_MS;
}

// ---------------------------------------------------------------------------
// The opt-out (S5)
// ---------------------------------------------------------------------------

/** The environment variable that suppresses auto-serve everywhere (S5). */
export const NO_AUTOSERVE_ENV = 'DIAGRAM_NO_AUTOSERVE';

/**
 * Is auto-serve switched off?
 *
 * Checked FIRST, before any file is read or any pid is signalled, so a context
 * that has opted out — the M8 eval harness above all — pays nothing.
 *
 * "0", "false", "no" and the empty string mean off-the-opt-out, so that a
 * shell profile exporting `DIAGRAM_NO_AUTOSERVE=0` does not silently disable a
 * feature it was trying to keep.
 */
export function autoServeSuppressed(noServe?: boolean): boolean {
  if (noServe === true) return true;
  const env = process.env[NO_AUTOSERVE_ENV];
  if (env === undefined) return false;
  const v = env.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

// ---------------------------------------------------------------------------
// The detached spawn (S3)
// ---------------------------------------------------------------------------

/** What a launcher is handed. Exported so the test seam is a typed contract. */
export interface LaunchRequest {
  /** The .diagram directory the viewer must serve (absolute). */
  dir: string;
  /** The port to request. The viewer still auto-increments on EADDRINUSE. */
  port: number;
}

/** A launcher returns the child's pid, or undefined if it could not start. */
export type Launcher = (req: LaunchRequest) => number | undefined;

/**
 * Locate the `diagram` binary this process was built alongside.
 *
 * Two layouts, because this module runs from two places (the same two
 * serve/http.ts documents for its public dir):
 *   compiled: dist/cli/src/serve/autoserve.js  → dist/bin/diagram.js
 *   TS source: packages/cli/src/serve/         → packages/cli/dist/bin/diagram.js
 *
 * Returns null when neither exists — running from source with nothing built.
 * Auto-serve then does nothing at all, silently: a patch must not fail, or
 * even nag, because a convenience could not find a binary.
 */
export function viewerEntry(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../bin/diagram.js'), // dist/cli/src/serve → dist/bin
    path.resolve(here, '../bin/diagram.js'), // dist/cli/src/serve → dist/cli/src/bin
    path.resolve(here, '../../dist/bin/diagram.js'), // src/serve → cli/dist/bin
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Start `diagram serve` as a process that outlives us (S3).
 *
 * The three flags together are what make that true, and dropping any one of
 * them produces a feature that works in every manual test and does nothing in
 * production:
 *
 *   detached: true   — a new process group / session leader on POSIX, so the
 *                      viewer does not receive the SIGINT that stops the agent
 *                      session, and is not reaped as a job of a dying shell.
 *   stdio: 'ignore'  — no inherited pipes. An inherited stdout keeps the
 *                      PARENT's pipe open (a caller waiting on our output
 *                      would hang), and worse, an MCP parent's stdout is the
 *                      JSON-RPC channel: a viewer writing its banner into it
 *                      breaks the framing for the whole session.
 *   unref()          — removes the child from our event loop's reference
 *                      count, so this process exits when its own work is done
 *                      instead of waiting for a server that never stops.
 *
 * DIAGRAM_NO_AUTOSERVE is forced on in the child's environment: the viewer
 * itself performs no writes, but a future one that did must never recurse.
 */
export function spawnViewer(req: LaunchRequest): number | undefined {
  const entry = viewerEntry();
  if (entry === null) return undefined;
  try {
    const child = spawn(
      process.execPath,
      [entry, 'serve', '--dir', req.dir, '--port', String(req.port)],
      {
        detached: true,
        stdio: 'ignore',
        // The parent of .diagram/ — a sane cwd that will not vanish, and not
        // the agent's cwd, which may be a temporary directory.
        cwd: path.dirname(path.resolve(req.dir)),
        env: { ...process.env, [NO_AUTOSERVE_ENV]: '1' },
      },
    );
    child.on('error', () => {
      /* the binary would not exec — nothing to say to the agent */
    });
    child.unref();
    return child.pid;
  } catch {
    return undefined;
  }
}

/**
 * The launcher in force. Replaceable ONLY so tests can start something they
 * can account for and kill; production never touches it.
 */
let launcher: Launcher = spawnViewer;

/** Test seam: install a launcher. Pass null to restore the real spawn. */
export function setViewerLauncher(fn: Launcher | null): void {
  launcher = fn ?? spawnViewer;
}

// ---------------------------------------------------------------------------
// Picking a port
// ---------------------------------------------------------------------------

/** Can we bind this port right now? Used to pick one, never to keep one. */
async function portFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, SERVE_HOST);
  });
}

/**
 * The first free port in the §9 range, or null when all eleven are taken.
 *
 * WHY THE SPAWNER PICKS. `diagram serve` auto-increments on EADDRINUSE, so a
 * child told "4400" may end up on 4403 and the line we print to the agent
 * would be a wrong URL — the one output the user is going to click. Choosing
 * here means the printed URL is the one the child requests. The child keeps
 * its own auto-increment as the backstop for the millisecond between our
 * close and its listen, and whatever it actually binds is what lands in the
 * pidfile, so the truth is never lost.
 */
export async function pickPort(
  from: number = DEFAULT_PORT,
  attempts: number = PORT_ATTEMPTS,
): Promise<number | null> {
  for (let port = from; port <= from + attempts; port += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    if (await portFree(port)) return port;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** What ensureViewer did. `skipped` always carries a reason, for tests. */
export type EnsureResult =
  | { action: 'reused'; url: string; port: number; pid: number }
  | { action: 'started'; url: string; port: number; pid: number }
  | { action: 'skipped'; reason: string };

export interface EnsureOptions {
  /** The .diagram directory (absolute). */
  dir: string;
  /** The graph.json this viewer must serve (absolute). */
  document: string;
  /** `--no-serve`. The environment variable is read here, not by the caller. */
  noServe?: boolean;
  /**
   * First port to try. Defaults to $DIAGRAM_PORT, else §9's 4400.
   *
   * It is a knob rather than a constant because 4400 is a shared resource on a
   * developer's machine — another project's viewer, a stale process, a test
   * run — and "auto-serve, but over there" is a reasonable thing to want. The
   * suite uses it so nothing here ever binds the port a real viewer may hold.
   */
  basePort?: number;
}

/** Environment override for the first port auto-serve tries. */
export const AUTOSERVE_PORT_ENV = 'DIAGRAM_PORT';

/** $DIAGRAM_PORT when it is a usable port number, else §9's 4400. */
export function defaultBasePort(): number {
  const raw = process.env[AUTOSERVE_PORT_ENV];
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number.parseInt(raw.trim(), 10);
  // Silently ignore nonsense rather than refuse to draw: a bad port in a
  // shell profile must not turn a working patch into an error.
  return Number.isInteger(n) && n > 0 && n <= 65_535 ? n : DEFAULT_PORT;
}

/**
 * Make sure a viewer is serving this document, and say what happened.
 *
 * Non-blocking in the sense S4 requires: the only awaits are the identity
 * probe (a localhost round trip, hard-capped) and the port scan. Nothing here
 * waits for the spawned server to bind — the pidfile it will write is the
 * handshake, and the browser tab reconnects on its own.
 */
export async function ensureViewer(opts: EnsureOptions): Promise<EnsureResult> {
  if (autoServeSuppressed(opts.noServe)) return { action: 'skipped', reason: 'opt-out' };

  const dir = path.resolve(opts.dir);
  const document = path.resolve(opts.document);

  const base = opts.basePort ?? defaultBasePort();

  // Two passes, never more. The second exists for one situation: another call
  // won the claim between our read and our write, so the answer we computed is
  // out of date and the record now on disk is the truth. Re-reading it turns
  // us into a reuse. A third pass could only mean something is thrashing the
  // pidfile, and spinning over that would spend the patch's latency budget on
  // a convenience.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = readServeRecord(dir);
    if (record !== null && (await isLive(record, document))) {
      // S2 and S6 in one line: no second viewer, and no second browser tab —
      // the one that is open repaints from the file watcher.
      return { action: 'reused', url: record.url, port: record.port, pid: record.pid };
    }
    // A stale or foreign entry is replaced in silence. The user did nothing
    // wrong; reporting it would be noise on a line they cannot act on.
    //
    // GUARDED BY THE PID it described, which is what removeServeRecord's whole
    // signature is for: isLive may have spent up to PROBE_TIMEOUT_MS on the
    // wire, and a viewer that installed a fresh, valid record during that
    // window must not have it deleted by our stale conclusion.
    if (record !== null) removeServeRecord(dir, record.pid);

    const port = await pickPort(base);
    if (port === null) {
      return { action: 'skipped', reason: `no free port in ${base}..${base + PORT_ATTEMPTS}` };
    }
    const url = `http://localhost:${port}/`;

    // THE CLAIM, taken BEFORE the spawn and atomically (see claimStart). The
    // pid recorded here is our own: it is the only pid that certainly exists
    // at this instant, and it makes the record self-verifying if we die
    // between claiming and spawning. The real child's pid overwrites it a
    // moment later.
    const claim = claimStart(dir, {
      contract: VIEWER_CONTRACT,
      pid: process.pid,
      port,
      url,
      document,
      dir,
      startedAt: Date.now(),
      state: 'starting',
    });
    if (claim === 'taken') continue;

    const pid = launcher({ dir, port });
    if (pid === undefined) {
      // Take the claim back, or the next patch would find our record, believe
      // it for the grace window (our pid IS alive) and start nothing either.
      removeServeRecord(dir, process.pid);
      return { action: 'skipped', reason: 'no viewer binary' };
    }

    // Now the record names the process that will actually be listening.
    writeServeRecord(dir, {
      contract: VIEWER_CONTRACT,
      pid,
      port,
      url,
      document,
      dir,
      startedAt: Date.now(),
      state: 'starting',
    });
    return { action: 'started', url, port, pid };
  }

  return { action: 'skipped', reason: 'a viewer is already starting' };
}
