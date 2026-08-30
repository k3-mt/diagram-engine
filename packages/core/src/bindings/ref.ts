// bindings/ref.ts — the PURE half of provenance (spec §3.8).
//
// A binding says where a claim was read. Proving it was read there means
// touching the filesystem, and `diagram check --bindings` does that. This file
// is everything that is decidable from the STRING alone: is this ref a path or
// an identifier, is it well formed, what does it normalise to, may it carry a
// line number. The checker is then only the IO — open the path, count the
// lines — which is what makes the checker testable without a fixture tree, and
// what keeps V16 (a validation rule, run on every patch) and the checker
// agreeing about what a ref means instead of drifting apart.
//
// Nothing here imports node:fs, and nothing here knows a root directory.

import type { BindingSource, GBinding, GraphDoc } from '../schema/graph.js';

/**
 * Why a ref is not usable. Every one of these is decidable from the string,
 * which is why they are validation errors (V16) and not checker findings: the
 * checker resolves refs against a directory on disk, so `../../etc/passwd`
 * reaching it at all is a security boundary crossed, not a typo to report.
 */
export type BindingRefProblem =
  | 'blank' // whitespace only
  | 'url' // any scheme: http(s)://, ssh://, file:, and scp-style git@host:path
  | 'absolute' // "/etc/passwd", "~/x", "C:/x" — not repo-relative
  | 'backslash' // Windows separators; the checker joins with "/"
  | 'traversal' // a ".." segment: escapes the root the checker resolves under
  | 'control-char'; // NUL, newline, tab — never a real path, often an injection

/**
 * A ref is a PATH when its shape says so, not when its source does. Source is
 * a poor signal: `compose=docker-compose.yml` cites a file and
 * `repo=services/orders/` cites a directory, so keying off the source would
 * misread both. Shape is deterministic and the same rule the checker needs:
 *
 *   contains "/"                       -> path   services/orders/, internal/pay.go
 *   last segment has a known extension -> path   pay.go, Dockerfile
 *   otherwise                          -> identifier
 *
 * The extension list is an ALLOWLIST on purpose. "any dot means a file" would
 * read `terraform=aws_ecs_service.orders` — the canonical terraform address
 * from §3.8 — as a file called `.orders`, and the checker would then report a
 * correct citation as missing. A wrong "missing" is the one failure mode this
 * whole feature exists to avoid.
 */
export const PATH_LIKE_EXTENSIONS: ReadonlySet<string> = new Set([
  'bash', 'c', 'cc', 'cfg', 'cjs', 'conf', 'cpp', 'cs', 'css', 'csv',
  'dockerfile', 'ejs', 'env', 'erb', 'ex', 'exs', 'go', 'gradle', 'graphql',
  'h', 'hcl', 'hpp', 'htm', 'html', 'ini', 'java', 'js', 'json', 'jsonnet',
  'jsx', 'kt', 'kts', 'lock', 'lua', 'md', 'mjs', 'mod', 'php', 'pl', 'proto',
  'properties', 'ps1', 'py', 'rb', 'rs', 'scala', 'sh', 'sql', 'sum', 'swift',
  'tf', 'tfvars', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml',
  'zsh',
]);

/** Extensionless filenames that are still unmistakably files. */
export const PATH_LIKE_FILENAMES: ReadonlySet<string> = new Set([
  'Dockerfile',
  'Makefile',
  'Procfile',
  'Rakefile',
  'Gemfile',
  'Jenkinsfile',
  'Caddyfile',
  'Vagrantfile',
]);

/** What a ref names. A path can be resolved on disk; an identifier cannot. */
export type BindingRefKind = 'path' | 'identifier';

export interface ParsedPathRef {
  ok: true;
  kind: 'path';
  /** The ref as written. */
  raw: string;
  /** Repo-relative, "/" separated, no "./" and no empty segments. */
  normalised: string;
  /** `normalised` split on "/", with no trailing empty segment. */
  segments: readonly string[];
  /**
   * The ref ended in "/", so it claims to be a directory. Absence proves
   * nothing: `services/orders` may still be a directory, and only the
   * checker's `stat` can say. That asymmetry is deliberate — the pure half
   * never guesses.
   */
  trailingSlash: boolean;
  /** Whether a `line` is meaningful here: a path that is not a directory. */
  acceptsLine: boolean;
}

export interface ParsedIdentifierRef {
  ok: true;
  kind: 'identifier';
  raw: string;
  /** Trimmed; identifiers are otherwise passed through untouched. */
  normalised: string;
  /** Always false: there is no file to count lines in. */
  acceptsLine: false;
}

export type ParsedBindingRef =
  | ParsedPathRef
  | ParsedIdentifierRef
  | { ok: false; problem: BindingRefProblem; raw: string };

/** `http://`, `https://`, `ssh://`, `file:`, `git@github.com:org/repo`. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const BARE_SCHEME = /^(mailto|file|data|git|ssh|s3|gs|urn|tel):/i;
/** scp-style, which git uses and which has no "//" to give it away. */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Is this ref a URL rather than a repo-relative path?
 *
 * `git@github.com:org/repo.git` and `ssh://host/path` are rejected as well as
 * `https://`. A SCHEME IS A SCHEME: the reason §3.8 bans URLs is that a
 * citation has to be resolvable against the repository the checker was pointed
 * at, and none of these are — they name somewhere else entirely, which is the
 * one thing a provenance claim must never do quietly. Rejecting only `http`
 * would leave the exact form a code-reading agent is most likely to paste (the
 * clone URL it saw in a README) as the one that slips through.
 */
export function isUrlLike(ref: string): boolean {
  return URL_SCHEME.test(ref) || BARE_SCHEME.test(ref) || SCP_LIKE.test(ref);
}

/** An npm scoped package: `@acme/utils`. Two segments, and not a path. */
const SCOPED_PACKAGE = /^@[^/\s]+\/[^/\s]+$/;

/**
 * A kubernetes resource address: `Deployment/orders`, `StatefulSet/pg-0`.
 *
 * A KIND is UpperCamelCase and a name is a DNS label, so the shape is
 * distinctive: no dot, no directory-ish spelling, and a capitalised first
 * segment that no repo-relative manifest path starts with. Left to the plain
 * "/" rule this reads as a path called `Deployment/orders`, and every correct
 * kind/name citation comes back missing — the same wrong "missing" the
 * extension allowlist and the scoped-package rule above exist to prevent, and
 * the reason §3.8's k8s row says "kind AND metadata.name" rather than a path.
 * A ref that names a manifest FILE (`deploy/orders.yaml`) has a lowercase
 * first segment and an extension, so it stays a path.
 */
const K8S_KIND_NAME = /^[A-Z][A-Za-z0-9]*\/[a-z0-9][a-z0-9._-]*$/;

/**
 * Path or identifier. Shape decides it (see PATH_LIKE_EXTENSIONS) — except
 * where the SOURCE settles what the ref can possibly name, which is two cases:
 *
 *  1. `repo` NAMES SOMETHING IN THE REPOSITORY. There is nothing else a
 *     repo-source ref could be: §3.8's examples are all paths, and "an
 *     identifier inside a file" is what the other four sources are for. Left to
 *     shape alone, `repo=schema.prisma` (prisma is not on the extension list)
 *     and `repo=totally_invented_thing` came back `unchecked` and exited 0 —
 *     an invented citation surviving the check that exists to catch it, and one
 *     the eval then excluded from precision while still counting it as effort.
 *     Under `repo` they are paths, they are resolved, and they are missing.
 *  2. `package=@acme/utils` is ONE package name, not a directory, and
 *     `k8s-manifest=Deployment/orders` is ONE resource address, not a
 *     directory called Deployment. The "/" rule
 *     would read it as a path and report every correct scoped-package citation
 *     as missing — the wrong "missing" this file exists to avoid, the same
 *     reason `terraform=aws_ecs_service.orders` is not a file called `.orders`.
 *
 * `compose`, `terraform` and `k8s-manifest` otherwise keep the pure shape
 * rule: a service key, a resource address and a manifest resource name are all
 * legitimate identifiers, and each of the three can equally name a file
 * (`compose=docker-compose.yml`, `k8s-manifest=deploy/orders.yaml`).
 */
export function bindingRefKind(ref: string, source?: BindingSource): BindingRefKind {
  const trimmed = ref.trim();
  if (source === 'package' && SCOPED_PACKAGE.test(trimmed)) return 'identifier';
  if (source === 'k8s-manifest' && K8S_KIND_NAME.test(trimmed)) return 'identifier';
  if (source === 'repo') return 'path';
  if (trimmed.includes('/')) return 'path';
  const dot = trimmed.lastIndexOf('.');
  if (dot > 0) {
    const ext = trimmed.slice(dot + 1).toLowerCase();
    if (PATH_LIKE_EXTENSIONS.has(ext)) return 'path';
  }
  if (PATH_LIKE_FILENAMES.has(trimmed)) return 'path';
  return 'identifier';
}

/**
 * Parse one ref. The single entry point the checker codes against: it hands
 * back either a normalised path it may join to its root, an identifier it must
 * NOT try to resolve as a file, or a problem — and a problem here means the
 * document should never have validated, because V16 rejects all six.
 */
export function parseBindingRef(ref: string, source?: BindingSource): ParsedBindingRef {
  const raw = ref;
  if (CONTROL_CHARS.test(ref)) return { ok: false, problem: 'control-char', raw };
  const trimmed = ref.trim();
  if (trimmed === '') return { ok: false, problem: 'blank', raw };
  if (isUrlLike(trimmed)) return { ok: false, problem: 'url', raw };
  if (trimmed.includes('\\')) return { ok: false, problem: 'backslash', raw };
  if (trimmed.startsWith('/') || trimmed.startsWith('~') || WINDOWS_DRIVE.test(trimmed)) {
    return { ok: false, problem: 'absolute', raw };
  }

  if (bindingRefKind(trimmed, source) === 'identifier') {
    return { ok: true, kind: 'identifier', raw, normalised: trimmed, acceptsLine: false };
  }

  const trailingSlash = trimmed.endsWith('/');
  const segments: string[] = [];
  for (const seg of trimmed.split('/')) {
    if (seg === '' || seg === '.') continue; // "a//b" and "./a" mean "a/b" and "a"
    if (seg === '..') return { ok: false, problem: 'traversal', raw };
    segments.push(seg);
  }
  if (segments.length === 0) return { ok: false, problem: 'blank', raw };

  const normalised = segments.join('/') + (trailingSlash ? '/' : '');
  return {
    ok: true,
    kind: 'path',
    raw,
    normalised,
    segments,
    trailingSlash,
    acceptsLine: !trailingSlash,
  };
}

/**
 * `repo=services/orders/`, `repo=internal/pay.go:412`, `compose=orders-api`.
 * One spelling, used by the get-table (§4.1) and by the checker's report
 * (§3.8) so an agent reading a failure can find the exact string to fix.
 */
export function formatBinding(b: GBinding): string {
  return `${b.source}=${b.ref}${b.line === undefined ? '' : `:${b.line}`}`;
}

/** Which half of the document a binding hangs off. */
export type BoundElementKind = 'node' | 'edge';

/** One binding, with the element that carries it. Document order. */
export interface BoundBinding {
  kind: BoundElementKind;
  /** The node or edge id. */
  id: string;
  binding: GBinding;
}

/**
 * Every binding in the document, nodes first then edges, each in document
 * order — the same order the get-table prints and the checker reports, so a
 * failure line and a table row can be matched by eye.
 */
export function collectBindings(doc: GraphDoc): BoundBinding[] {
  const out: BoundBinding[] = [];
  for (const n of doc.nodes) {
    for (const binding of n.bindings ?? []) out.push({ kind: 'node', id: n.id, binding });
  }
  for (const e of doc.edges) {
    for (const binding of e.bindings ?? []) out.push({ kind: 'edge', id: e.id, binding });
  }
  return out;
}

/** The checker's header line: "bindings — 14 elements, 22 bindings". */
export function summariseBindings(doc: GraphDoc): { elements: number; bindings: number } {
  const all = collectBindings(doc);
  const elements = new Set(all.map((b) => `${b.kind}\x00${b.id}`));
  return { elements: elements.size, bindings: all.length };
}
