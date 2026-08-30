// bindings/resolve.ts — the IO half of provenance (spec §3.8, P5-02).
//
// ref.ts decides what a ref MEANS from the string alone. This file is the only
// part that touches a disk: it takes a parsed ref, joins it under a root, and
// answers the one question the whole feature exists for — is the file this
// document cites actually there, and does it still have the line the document
// points at?
//
// Deterministic, in the strong sense: no model, no heuristic, no network, no
// clock. Same document and same tree, same answer, every time. That is what
// lets it run in CI on every commit (spec §3.8, property 1).
//
// It is NOT exported from bindings/index.ts. That barrel is deliberately free
// of node:fs so the viewer can import the parsing half by path (P5-03); this
// module reaches consumers through core's main barrel instead, which already
// pulls in node:fs for readDoc and withLock.
//
// R5 holds here as strictly as it does in the schema: a result says where a
// claim was read and whether that place still exists. It says nothing about a
// running system, records no timestamp, and is never written back into the
// document.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphDoc } from '../schema/graph.js';
import {
  collectBindings,
  formatBinding,
  parseBindingRef,
  summariseBindings,
  type BoundBinding,
  type BoundElementKind,
} from './ref.js';

/**
 * What happened to one binding.
 *
 *   ok            the path resolves under the root, and the line is within it
 *   missing       nothing is there
 *   stale         something is there, but not what the ref claims: a line past
 *                 the end of the file, a directory where a line was cited, a
 *                 file where a trailing slash promised a directory
 *   escaped       it resolves OUTSIDE the root — a symlink out of the tree
 *   malformed     the ref is not usable at all; V16 rejects every such ref, so
 *                 seeing one means the file was hand-edited past validation
 *   unchecked     there is nothing on disk this could name: an identifier
 *                 (`compose=orders-api`), or a file too large to count lines in
 *
 * `unchecked` is a first-class outcome rather than a quiet `ok` on purpose.
 * Reporting an unresolvable class as verified would be the same lie this
 * feature exists to prevent — an identifier is honestly UNCHECKED, and the
 * report says so and counts it separately.
 */
export type BindingStatus = 'ok' | 'unchecked' | 'missing' | 'stale' | 'escaped' | 'malformed';

/** One binding, resolved. `reason` is empty only for `ok`. */
export interface ResolvedBinding {
  kind: BoundElementKind;
  /** The node or edge id the binding hangs off. */
  id: string;
  /** `repo=internal/pay.go:412` — the exact string to find in the document. */
  formatted: string;
  status: BindingStatus;
  /** Why, in the words the report prints. `''` when ok. */
  reason: string;
}

/** The whole answer. `ok` is the exit-code question: nothing failed. */
export interface BindingReport {
  /** The root every path ref was resolved against (absolute, symlinks collapsed). */
  root: string;
  /** How many nodes and edges carry at least one binding. */
  elements: number;
  /** How many bindings there are in total. */
  bindings: number;
  /** Every binding, in document order: nodes first, then edges. */
  results: readonly ResolvedBinding[];
  /** Count per status, present for every status (0 when none). */
  counts: Readonly<Record<BindingStatus, number>>;
  /**
   * True when no binding is missing, stale, escaped or malformed.
   *
   * `unchecked` does NOT fail. An identifier is not a broken citation, it is a
   * citation of a kind this checker cannot resolve, and failing CI for it would
   * teach agents to stop writing `terraform=aws_ecs_service.orders` — the most
   * precise citation available for a terraform resource.
   */
  ok: boolean;
}

/**
 * Line counting reads the whole file, so there has to be a ceiling; a document
 * that cites a 2 GB vendored blob must not make `diagram check` allocate it.
 * Over the ceiling the existence check still stands and the LINE is reported
 * as unchecked, which is the honest answer: we know the file is there and we
 * did not count. Reporting `stale` instead would be a false accusation.
 */
export const MAX_LINE_COUNT_BYTES = 32 * 1024 * 1024;

/** The statuses that mean a citation is wrong, and so fail the check. */
const FAILING: ReadonlySet<BindingStatus> = new Set<BindingStatus>([
  'missing',
  'stale',
  'escaped',
  'malformed',
]);

/** Why a malformed ref is malformed, in the report's words. */
const MALFORMED_REASON: Readonly<Record<string, string>> = {
  blank: 'ref is blank',
  url: 'ref is a URL, not a repo-relative path',
  absolute: 'ref is an absolute path, not repo-relative',
  backslash: 'ref uses backslashes, not "/"',
  traversal: 'ref escapes the root with ".."',
  'control-char': 'ref contains a control character',
};

/**
 * Count lines the way an editor does: the number of newline-terminated lines,
 * plus a final unterminated one if the file does not end in a newline. An
 * empty file has zero lines, so a `line: 1` on it is correctly stale.
 *
 * Bytes, not text: the file may not be UTF-8, and 0x0A cannot appear inside a
 * multi-byte UTF-8 sequence, so counting bytes is both cheaper and safer than
 * decoding something that might be a binary the document should not have cited.
 */
export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (const b of buf) if (b === 0x0a) lines += 1;
  return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
}

/**
 * Is `child` the root itself, or inside it?
 *
 * Compared as path segments rather than as a string prefix: `/repo-backup`
 * starts with `/repo` and is a different tree entirely, and a checker that
 * accepted it would resolve a citation against a directory nobody pointed it
 * at. Both arguments must already be real (symlink-free) absolute paths.
 */
export function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = path.relative(root, child);
  // Segments, not a string prefix, on BOTH sides: `/repo-backup` starts with
  // `/repo`, and a child named `..%2fetc` makes `rel` start with ".." while
  // being an ordinary file inside the root. The first mistake reads a
  // directory nobody pointed at; the second calls a missing file an escape and
  // sends the reader hunting a security problem that is not there.
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

/** `stat` without throwing: undefined when the path is not there. */
function statOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

/**
 * A per-run cache of directory listings, so a document citing forty files
 * under one directory reads that directory once. Keyed by absolute path;
 * `null` means the listing could not be read.
 */
export type DirCache = Map<string, readonly string[] | null>;

function readdirCached(dir: string, cache: DirCache | undefined): readonly string[] | null {
  const hit = cache?.get(dir);
  if (hit !== undefined) return hit;
  let entries: readonly string[] | null;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = null;
  }
  cache?.set(dir, entries);
  return entries;
}

/**
 * Does every segment of the ref match the name on disk EXACTLY, byte for byte?
 *
 * The answer has to come from a directory listing, not from `stat`, because on
 * a case-insensitive or normalisation-insensitive filesystem — every default
 * macOS volume, and NTFS — the kernel answers "yes, that file exists" for a
 * spelling that is not on disk, and `fs.realpathSync` on macOS hands back the
 * spelling it was ASKED for rather than the stored one, so it cannot see the
 * difference either. Without this walk `repo=Internal/PAY.GO:3` reports `ok`
 * on a laptop and `missing` on a Linux CI box, from the same document and the
 * same commit. A checker whose verdict depends on the developer's filesystem
 * is exactly the "reads as evidence" failure §3.8 exists to prevent — and the
 * eval, which calls this same resolver, would score such a citation as honest
 * provenance.
 *
 * Unicode is the same defect in a second dress and the same fix: a name stored
 * NFC and cited NFD compares unequal here, as it must, because it will not
 * resolve on the machine the reference system lives on.
 *
 * Returns the on-disk spelling of the first segment that differs, or undefined
 * when every segment matches (or when a listing could not be read, in which
 * case the earlier `stat` stands rather than a guess being invented).
 */
function firstMisspelledSegment(
  realRoot: string,
  segments: readonly string[],
  cache: DirCache | undefined,
): { cited: string; onDisk: string } | undefined {
  let dir = realRoot;
  for (const seg of segments) {
    const entries = readdirCached(dir, cache);
    if (entries === null) return undefined; // unreadable: do not invent a verdict
    if (!entries.includes(seg)) {
      const onDisk = entries.find(
        (e) => e.toLowerCase() === seg.toLowerCase() || e.normalize('NFC') === seg.normalize('NFC'),
      );
      return { cited: seg, onDisk: onDisk ?? '' };
    }
    dir = path.join(dir, seg);
  }
  return undefined;
}

/**
 * Resolve ONE binding against a real root.
 *
 * `realRoot` must already be `fs.realpathSync`'d by the caller, so that the
 * containment test below compares like with like: if the root itself is
 * reached through a symlink (every /tmp on macOS is), a real child path would
 * otherwise look as though it escaped.
 *
 * The security story, in order:
 *
 *   1. `..`, absolute refs and backslash refs never get here — V16 rejects
 *      them on every write path, and this function reports one as `malformed`
 *      rather than resolving it, because a document containing one was
 *      hand-edited past validation and is not to be trusted with a path join.
 *   2. What is left has no `..` and no leading `/`, so the join cannot escape
 *      lexically. It is checked anyway.
 *   3. `fs.realpathSync` then collapses every symlink in the chain, and the
 *      result is re-checked against the root. This is the one that catches a
 *      symlink pointing out of the tree, which no amount of string handling
 *      can see. Two locks on a door that opens onto the developer's home
 *      directory is the right number.
 *   4. The path is then re-spelled against the directory listings, because on
 *      a case- or normalisation-insensitive filesystem every check above says
 *      yes to a name that is not on disk (firstMisspelledSegment).
 */
export function resolveBinding(
  bound: BoundBinding,
  realRoot: string,
  cache?: DirCache,
): ResolvedBinding {
  const base = {
    kind: bound.kind,
    id: bound.id,
    formatted: formatBinding(bound.binding),
  };
  const finish = (status: BindingStatus, reason: string): ResolvedBinding => ({
    ...base,
    status,
    reason,
  });

  const parsed = parseBindingRef(bound.binding.ref, bound.binding.source);
  if (!parsed.ok) {
    return finish('malformed', MALFORMED_REASON[parsed.problem] ?? 'ref is not a usable path');
  }

  // An identifier names a thing INSIDE a file, not a file: `compose=orders-api`
  // is a service key, `terraform=aws_ecs_service.orders` a resource address.
  // Joining either to the root and stat-ing it would report every correct
  // terraform citation in the corpus as missing, which is precisely the wrong
  // "missing" this checker exists to avoid. It is reported as unchecked.
  if (parsed.kind === 'identifier') {
    return finish('unchecked', 'identifier, not a path — nothing on disk to resolve');
  }

  const joined = path.resolve(realRoot, ...parsed.segments);
  // Lock 2 (lexical). Unreachable while V16 stands; cheap, and the cost of
  // being wrong here is reading a file outside the project.
  if (!isInside(realRoot, joined)) {
    return finish('escaped', 'resolves outside the root');
  }

  let real: string;
  try {
    real = fs.realpathSync(joined);
  } catch {
    // ENOENT, and also a dangling symlink — which is honestly missing: the
    // path the document cites does not lead to anything.
    return finish('missing', 'no such path');
  }
  // Lock 3 (symlinks). realpathSync has followed the whole chain, so a link
  // inside the tree that points out of it is caught here and nowhere else.
  if (!isInside(realRoot, real)) {
    // Naming where it went is the difference between an intentional monorepo
    // link and a leak, and the reader cannot tell those apart from the ref.
    return finish('escaped', `symlink resolves outside the root (→ ${real})`);
  }

  // Lock 4 (spelling). The filesystem has said the path exists; that is not
  // the same as the path the document cites existing. See
  // firstMisspelledSegment.
  const wrong = firstMisspelledSegment(realRoot, parsed.segments, cache);
  if (wrong !== undefined) {
    return finish(
      'missing',
      wrong.onDisk === ''
        ? `no such path: "${wrong.cited}" is not there`
        : `no such path: on disk it is "${wrong.onDisk}", not "${wrong.cited}"`,
    );
  }

  const st = statOrUndefined(real);
  if (st === undefined) return finish('missing', 'no such path');

  // A trailing slash is a CLAIM that this is a directory (§3.8's
  // `repo=services/orders/`). Its absence claims nothing — `services/orders`
  // may legitimately be either — so only the positive claim is checked.
  if (parsed.trailingSlash && !st.isDirectory()) {
    return finish('stale', 'not a directory');
  }

  const line = bound.binding.line;

  // A ref names a file or a directory. A FIFO, a socket or a device node is
  // neither, and calling one a verified source citation is the same lie as
  // citing a file that is not there. Checked ABOVE the `line === undefined`
  // exit, or the same pipe reads `ok` without a line and `stale` with one.
  if (!st.isDirectory() && !st.isFile()) {
    return finish(
      'stale',
      line === undefined
        ? 'not a regular file'
        : `not a regular file, so line ${line} cites nothing`,
    );
  }

  if (line === undefined) return finish('ok', '');

  // V16 keeps `line` off a trailing-slash ref and off an identifier, so a line
  // here is always a claim about a file. Whether the path IS a file is another
  // matter: `services/orders:12` validates, because the pure half refuses to
  // guess what an extensionless path is, and this is where it finds out.
  if (st.isDirectory()) {
    return finish('stale', `is a directory, so line ${line} cites nothing`);
  }
  if (st.size > MAX_LINE_COUNT_BYTES) {
    return finish(
      'unchecked',
      `file exists but is over ${Math.floor(MAX_LINE_COUNT_BYTES / (1024 * 1024))} MB — line not counted`,
    );
  }

  // The one syscall left, and it is guarded like every other one in this file.
  // A file that stats but cannot be opened (mode 000, a root-owned artefact, a
  // vendored submodule) must cost its own row and nothing else: an uncaught
  // EACCES here threw out of the whole run and printed one permissions line
  // instead of the report — every binding that resolved perfectly lost with it.
  // A check that cannot survive a chmod is a check that gets turned off.
  let buf: Buffer;
  try {
    buf = fs.readFileSync(real);
  } catch {
    return finish('unchecked', 'file exists but could not be read — line not counted');
  }
  const lines = countLines(buf);
  if (lines < line) {
    return finish('stale', `file has ${lines === 1 ? '1 line' : `${lines} lines`}`);
  }
  return finish('ok', '');
}

/**
 * Resolve every binding in the document against `root`.
 *
 * `root` is the PROJECT root, not the .diagram directory: a ref is
 * repo-relative (§3.8), and `repo=internal/pay.go` means the repository's
 * internal/, not .diagram/internal/. The caller decides what the project root
 * is; this only resolves against what it is given.
 *
 * A root that does not exist is not a per-binding failure — it is one fact
 * about the whole run, so every path binding comes back `missing` with the
 * same reason and the report says the root is absent. Silently reporting
 * twenty-two missing files when the real problem is one wrong `--root` is how
 * a checker sends an agent to delete correct citations.
 */
export function resolveBindings(doc: GraphDoc, root: string): BindingReport {
  const { elements, bindings } = summariseBindings(doc);
  const all = collectBindings(doc);

  let realRoot: string | undefined;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    realRoot = undefined;
  }

  const cache: DirCache = new Map();
  const results: ResolvedBinding[] =
    realRoot === undefined
      ? all.map((b) => {
          const parsed = parseBindingRef(b.binding.ref, b.binding.source);
          const formatted = formatBinding(b.binding);
          if (parsed.ok && parsed.kind === 'identifier') {
            return {
              kind: b.kind,
              id: b.id,
              formatted,
              status: 'unchecked' as const,
              reason: 'identifier, not a path — nothing on disk to resolve',
            };
          }
          return {
            kind: b.kind,
            id: b.id,
            formatted,
            status: 'missing' as const,
            reason: 'the root itself does not exist',
          };
        })
      : all.map((b) => resolveBinding(b, realRoot as string, cache));

  const counts: Record<BindingStatus, number> = {
    ok: 0,
    unchecked: 0,
    missing: 0,
    stale: 0,
    escaped: 0,
    malformed: 0,
  };
  for (const r of results) counts[r.status] += 1;

  return {
    // The root the containment decisions were ACTUALLY made against. When the
    // root is reached through a symlink the two differ, and printing the
    // pre-realpath spelling sends an operator debugging an `escaped` row to
    // read the wrong directory.
    root: realRoot ?? path.resolve(root),
    elements,
    bindings,
    results,
    counts,
    ok: !results.some((r) => FAILING.has(r.status)),
  };
}
