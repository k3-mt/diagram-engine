// bindings/identifier.ts — the PURE half of identifier-ref resolution (§3.8).
//
// ref.ts answers "is this ref a path or an identifier". This file answers the
// question that follows: given the TEXT of a file, does that file DEFINE this
// identifier? Nothing here opens a file, knows a directory or imports node:fs;
// the walk that finds candidate files lives in resolve.ts. That split is what
// makes every pattern below testable against a string with no fixture tree,
// and it mirrors how the path half was built.
//
// The rule the whole file is written against: **a bare substring match is the
// failure mode**. `aws_ecs_service.orders` appears in READMEs, in comments, in
// commit messages and inside longer names, and reporting a citation `ok`
// because the string appears SOMEWHERE is exactly the lie provenance exists to
// prevent. Every matcher below is anchored to the structure that constitutes a
// definition — a block header, a mapping key at a known indent, a JSON field.
//
// The second rule: when a precise pattern cannot be written, say `unchecked`
// and say why. Guessing `ok` invents evidence; guessing `absent` reports a
// correct citation as a broken one. Both are worse than admitting.
//
// NO YAML PARSER. `npm run check` enforces a dependency allowlist and this
// feature is not worth a runtime dependency, so compose and k8s are matched by
// bounded, structured line scanning: top-level keys, exact indents, document
// separators. That is strictly weaker than parsing, and each matcher's header
// says exactly which valid YAML it cannot read — every one of those cases
// returns `unchecked` rather than a verdict.

import type { BindingSource } from '../schema/graph.js';

/** The four sources whose refs can name something inside a file. */
export type IdentifierSource = 'terraform' | 'compose' | 'package' | 'k8s-manifest';

const IDENTIFIER_SOURCES: ReadonlySet<BindingSource> = new Set<BindingSource>([
  'terraform',
  'compose',
  'package',
  'k8s-manifest',
]);

/** Can a ref from this source name a thing inside a file? `repo` cannot. */
export function isIdentifierSource(source: BindingSource): source is IdentifierSource {
  return IDENTIFIER_SOURCES.has(source);
}

/**
 * What one file had to say about one identifier.
 *
 *   defines    the structured pattern matched, at `line` (1-based)
 *   absent     the file is of the right kind and does not define it
 *   unchecked  this file cannot be read precisely enough to say either way
 *
 * `unchecked` is per FILE, not per binding: one compose file written in flow
 * style does not stop a second one from answering. resolve.ts only reports a
 * binding `unchecked` when no candidate file could answer it.
 */
export type IdentifierMatch =
  | { verdict: 'defines'; line: number }
  | { verdict: 'absent' }
  | { verdict: 'unchecked'; reason: string };

const ABSENT: IdentifierMatch = { verdict: 'absent' };

/** 1-based line number of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Escape a user-supplied identifier for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Which files can hold which kind of definition
// ---------------------------------------------------------------------------

/**
 * Does this FILENAME (the basename, never a path) belong to the set of files
 * this source can live in? Straight off §3.8's table:
 *
 *   terraform      *.tf
 *   compose        docker-compose*.y{a,}ml, compose*.y{a,}ml
 *   package        package.json
 *   k8s-manifest   *.yaml, *.yml
 *
 * Name-based on purpose: it is decidable from a directory listing, so the walk
 * in resolve.ts opens only files of the kind the source names (§3.8 rule 3).
 *
 * Deliberately NOT matched: `*.tf.json` (Terraform's JSON syntax — a different
 * grammar, and matching it with the HCL patterns below would be a guess),
 * `*.tfvars` (variable VALUES, not declarations), Helm chart templates (they
 * are Go templates, not YAML, until they are rendered), and Kustomize output
 * that exists only after a build.
 */
export function isCandidateFilename(source: IdentifierSource, filename: string): boolean {
  const name = filename.toLowerCase();
  switch (source) {
    case 'terraform':
      return name.endsWith('.tf');
    case 'compose':
      return (
        (name.startsWith('docker-compose') || name.startsWith('compose')) &&
        (name.endsWith('.yml') || name.endsWith('.yaml'))
      );
    case 'package':
      return name === 'package.json';
    case 'k8s-manifest':
      return name.endsWith('.yaml') || name.endsWith('.yml');
  }
}

/**
 * How the report names the files it looked in, for the `missing` line when
 * there are none: "no *.tf file under the root". A citation to Terraform in a
 * repository with no Terraform is a wrong citation (§3.8 rule 1), and the
 * reader needs to be told what was looked for.
 */
export function candidateDescription(source: IdentifierSource): string {
  switch (source) {
    case 'terraform':
      return '*.tf';
    case 'compose':
      return 'docker-compose*.y*ml / compose*.y*ml';
    case 'package':
      return 'package.json';
    case 'k8s-manifest':
      return '*.yaml / *.yml';
  }
}

// ---------------------------------------------------------------------------
// terraform
// ---------------------------------------------------------------------------

/**
 * A Terraform address, turned into the block header that DECLARES it:
 *
 *   aws_ecs_service.orders      resource "aws_ecs_service" "orders" {
 *   aws_ecs_service.orders.id   the same block; the third part is an attribute
 *   module.foo                  module "foo" {
 *   data.aws_ami.ubuntu         data "aws_ami" "ubuntu" {
 *   var.foo                     variable "foo" {
 *
 * The pattern is anchored to the start of a line (leading whitespace only) and
 * the names are inside DOUBLE QUOTES, which is what makes it structural rather
 * than a substring. Whitespace between the tokens varies and is allowed to;
 * the quoting does not vary — HCL has no other spelling for a block header.
 *
 * It deliberately does NOT match:
 *   - `# resource "aws_ecs_service" "orders"` — a comment, `#` or `//` or
 *     inside `/* *\/`; the line-start anchor excludes all three.
 *   - `aws_ecs_service.orders` in a README, a string literal, an output value
 *     or a `depends_on` — a USE is not a definition.
 *   - `resource "aws_ecs_service" "orders_legacy"` — the closing quote makes
 *     the name exact, so a longer name is a different resource.
 *   - a block header whose `{` is on the next line (HCL requires it on the
 *     header line, so this costs nothing real).
 *   - a resource whose name is produced by `for_each`/`count` interpolation:
 *     the literal name is not in the file and no pattern can find it. That is
 *     an `absent`, not an `unchecked`, because the file genuinely does not
 *     contain the declaration the ref names.
 */
export function terraformPattern(
  identifier: string,
): { ok: true; regexp: RegExp } | { ok: false; reason: string } {
  const parts = identifier.split('.');
  if (parts.some((p) => p === '')) {
    return { ok: false, reason: 'not a terraform address (empty part)' };
  }
  const q = (s: string) => `"${escapeRegExp(s)}"`;
  const header = (keyword: string, labels: string[]) =>
    new RegExp(`^[ \\t]*${keyword}[ \\t]+${labels.join('[ \\t]+')}[ \\t]*(\\{|$)`, 'm');

  const [first, second, third] = parts as [string, string?, string?];

  // `local.x` names a key inside a `locals { ... }` block, and `each`/`count`/
  // `self` name nothing declared at all. A precise pattern for a key inside a
  // block needs block-scope tracking that a line regex cannot do, so this is
  // one of the two honest `unchecked` cases in the file.
  if (first === 'local' || first === 'locals') {
    return { ok: false, reason: 'a local is a key inside a locals block — no precise pattern' };
  }
  if (first === 'each' || first === 'count' || first === 'self' || first === 'path') {
    return { ok: false, reason: `"${first}" names no declared block` };
  }

  if (first === 'var' || first === 'variable') {
    if (second === undefined || third !== undefined) {
      return { ok: false, reason: 'not a terraform variable address' };
    }
    return { ok: true, regexp: header('variable', [q(second)]) };
  }
  if (first === 'output') {
    if (second === undefined || third !== undefined) {
      return { ok: false, reason: 'not a terraform output address' };
    }
    return { ok: true, regexp: header('output', [q(second)]) };
  }
  if (first === 'module') {
    // `module.foo.bar` reads an OUTPUT of module foo. The module block is what
    // the ref ultimately points into, so the header is still the definition.
    if (second === undefined) return { ok: false, reason: 'not a terraform module address' };
    return { ok: true, regexp: header('module', [q(second)]) };
  }
  if (first === 'data') {
    if (second === undefined || third === undefined) {
      return { ok: false, reason: 'not a terraform data address (want data.TYPE.NAME)' };
    }
    return { ok: true, regexp: header('data', [q(second), q(third)]) };
  }
  if (first === 'resource') {
    // The written-out form `resource.aws_ecs_service.orders`, which is not a
    // real address but is a plausible thing to cite.
    if (second === undefined || third === undefined) {
      return { ok: false, reason: 'not a terraform resource address' };
    }
    return { ok: true, regexp: header('resource', [q(second), q(third)]) };
  }
  // TYPE.NAME, optionally followed by one attribute.
  if (second === undefined) {
    return { ok: false, reason: 'not a terraform address (want TYPE.NAME)' };
  }
  if (parts.length > 3) {
    return { ok: false, reason: 'not a terraform address (too many parts)' };
  }
  return { ok: true, regexp: header('resource', [q(first), q(second)]) };
}

/** Does this `.tf` file declare this address? */
export function terraformDefines(text: string, identifier: string): IdentifierMatch {
  const pattern = terraformPattern(identifier);
  if (!pattern.ok) return { verdict: 'unchecked', reason: pattern.reason };
  const m = pattern.regexp.exec(text);
  if (m === null) return ABSENT;
  return { verdict: 'defines', line: lineAt(text, m.index) };
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

/** A mapping key, bare or quoted: `orders-api:`, `"orders-api":`, `'x':`. */
function keyAtIndent(line: string, indent: string, key: string): boolean {
  const re = new RegExp(
    `^${escapeRegExp(indent)}(?:${escapeRegExp(key)}|"${escapeRegExp(key)}"|'${escapeRegExp(key)}')[ \\t]*:`,
  );
  return re.test(line);
}

const BLANK_OR_COMMENT = /^[ \t]*(#.*)?$/;

/** Leading whitespace of a line. */
function indentOf(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/**
 * Is `name` a service key under the top-level `services:` mapping?
 *
 * Without a YAML parser the block has to be bounded by hand, and this is how:
 *
 *   1. find a line that is exactly `services:` at column 0 (comment allowed
 *      after it). Anything indented is not the top-level key.
 *   2. the block runs until the next line that starts at column 0 with a
 *      non-comment character — the next top-level key — or the end of the
 *      document (`---`), or EOF.
 *   3. inside the block, the SERVICE KEYS are the lines at the block's own
 *      indent, which is taken from the first non-blank, non-comment line.
 *      Every deeper line belongs to a service, not to `services`.
 *
 * So a match means: a key spelled exactly `name` (bare, or quoted with either
 * quote) at exactly the service indent. A service literally named `volumes` or
 * `networks` matches correctly, because step 2 only ends the block on a
 * COLUMN-0 key and a service key is indented.
 *
 * What breaks it, and is therefore `unchecked` rather than guessed:
 *   - `services: {orders-api: {...}}` — flow style on the same line.
 *   - a `<<: *anchor` merge key inside the services block: the real service
 *     set is then partly in the anchor and this scan cannot follow it.
 *   - tabs used for indentation (not legal YAML, so the file is not readable
 *     as YAML by anything).
 *   - an inconsistent service indent inside one block (`  a:` then `    b:`),
 *     which is invalid YAML but would otherwise silently hide `b`.
 * And what it simply does not match, correctly: the name appearing under
 * `depends_on:`, in a `container_name:`, in a comment, or as a substring of a
 * longer key — the indent-plus-colon anchor excludes every one of them.
 */
export function composeDefines(text: string, name: string): IdentifierMatch {
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!/^services[ \t]*:/.test(line)) continue;
    const rest = line.replace(/^services[ \t]*:/, '');
    if (!BLANK_OR_COMMENT.test(rest)) {
      return {
        verdict: 'unchecked',
        reason: 'services is written in flow style — needs a YAML parser',
      };
    }

    // Walk the block.
    let indent: string | undefined;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j] as string;
      if (BLANK_OR_COMMENT.test(l)) continue;
      if (/^---[ \t]*(#.*)?$/.test(l) || /^\.\.\.[ \t]*$/.test(l)) break; // end of document
      const ind = indentOf(l);
      if (ind === '') break; // the next top-level key: the block is over
      if (ind.includes('\t')) {
        return {
          verdict: 'unchecked',
          reason: 'the services block is indented with tabs — not valid YAML',
        };
      }
      if (indent === undefined) indent = ind;
      if (ind.length < indent.length) break; // dedented out of the block
      if (ind.length > indent.length) continue; // inside one service
      if (/^[ \t]*<<[ \t]*:/.test(l)) {
        return {
          verdict: 'unchecked',
          reason: 'the services block uses a YAML merge key — needs a YAML parser',
        };
      }
      if (ind !== indent) {
        return {
          verdict: 'unchecked',
          reason: 'the services block mixes indent characters — needs a YAML parser',
        };
      }
      if (keyAtIndent(l, indent, name)) return { verdict: 'defines', line: j + 1 };
    }
  }
  return ABSENT;
}

// ---------------------------------------------------------------------------
// package
// ---------------------------------------------------------------------------

/**
 * Is this the `name` of this package.json? JSON.parse is built in, so this one
 * is exact rather than approximate — the only matcher here that is.
 *
 * It matches the top-level `name` field and NOTHING else: a key under
 * `dependencies`, `devDependencies` or `peerDependencies` spelled
 * `@acme/orders` is a package this one DEPENDS on, not the package being
 * named, and reporting that `ok` would verify a citation to a file the agent
 * never opened. A `workspaces` entry is likewise not this package's name.
 *
 * A package.json that is not valid JSON is `unchecked`, not `absent`: the file
 * may well declare the name, and we cannot see it.
 */
export function packageDefines(text: string, name: string): IdentifierMatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { verdict: 'unchecked', reason: 'package.json is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ABSENT;
  const value = (parsed as Record<string, unknown>)['name'];
  if (typeof value !== 'string' || value !== name) return ABSENT;
  // The line is a convenience for the reader, so a regex that may fail to find
  // it is fine: the verdict is already settled by the parse.
  const m = /^[ \t]*"name"[ \t]*:/m.exec(text);
  return { verdict: 'defines', line: m === null ? 1 : lineAt(text, m.index) };
}

// ---------------------------------------------------------------------------
// k8s-manifest
// ---------------------------------------------------------------------------

/**
 * `Deployment/orders` — a kind and a name, or a bare name.
 *
 * `kind: Deployment` and `metadata.name: orders` must come from the SAME
 * document. That is the whole difficulty: a `*.yaml` file routinely holds a
 * dozen documents separated by `---`, and matching the kind in one and the
 * name in another is a false positive, and the LIKELY one — a Deployment and a
 * Service for the same app sit next to each other in one file and share a
 * name, so a per-file match would report `Ingress/orders` `ok` in a file with
 * no Ingress at all.
 */
export function parseK8sIdentifier(
  identifier: string,
): { kind?: string; name: string } | { error: string } {
  const parts = identifier.split('/');
  if (parts.length === 1) {
    const name = parts[0] as string;
    if (name === '') return { error: 'blank name' };
    return { name };
  }
  if (parts.length === 2) {
    const [kind, name] = parts as [string, string];
    if (kind === '' || name === '') return { error: 'want KIND/name' };
    return { kind, name };
  }
  return { error: 'want KIND/name' };
}

/** Split on a `---` document separator at column 0. */
function splitDocuments(text: string): Array<{ lines: string[]; offset: number }> {
  const all = text.split('\n');
  const docs: Array<{ lines: string[]; offset: number }> = [];
  let current: string[] = [];
  let offset = 0;
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i] as string;
    if (/^---[ \t]*(#.*)?$/.test(line)) {
      docs.push({ lines: current, offset });
      current = [];
      offset = i + 1;
      continue;
    }
    current.push(line);
  }
  docs.push({ lines: current, offset });
  return docs;
}

/** Value of a top-level scalar key in one document, unquoted. */
function topLevelScalar(lines: readonly string[], key: string): string | undefined {
  const re = new RegExp(`^${escapeRegExp(key)}[ \\t]*:[ \\t]*(.*)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m === null) continue;
    const raw = (m[1] ?? '').replace(/[ \t]+#.*$/, '').trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1);
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1);
    return raw;
  }
  return undefined;
}

/**
 * Does one document declare a resource of `kind` named `name`?
 *
 * `metadata.name` is read as: the top-level `metadata:` key, then a `name:` at
 * the metadata block's own indent — which is what excludes the two names that
 * are NOT this resource's name, and both are common:
 *   - `spec.template.metadata.name` (the pod template's own metadata), and
 *   - `metadata.ownerReferences[].name` / `labels`, which are deeper still.
 * A bare `grep name: orders` would match all of them.
 *
 * Returns `unchecked` for `metadata: {name: orders}` (flow style) and for a
 * metadata block indented with tabs — the same honest refusals as compose.
 */
export function k8sDocumentDefines(
  lines: readonly string[],
  kind: string | undefined,
  name: string,
): IdentifierMatch {
  const docKind = topLevelScalar(lines, 'kind');
  if (docKind === undefined) return ABSENT; // not a manifest document at all
  if (kind !== undefined && docKind !== kind) return ABSENT;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!/^metadata[ \t]*:/.test(line)) continue;
    const rest = line.replace(/^metadata[ \t]*:/, '');
    if (!BLANK_OR_COMMENT.test(rest)) {
      return {
        verdict: 'unchecked',
        reason: 'metadata is written in flow style — needs a YAML parser',
      };
    }
    let indent: string | undefined;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j] as string;
      if (BLANK_OR_COMMENT.test(l)) continue;
      const ind = indentOf(l);
      if (ind === '') break; // next top-level key
      if (ind.includes('\t')) {
        return {
          verdict: 'unchecked',
          reason: 'the metadata block is indented with tabs — not valid YAML',
        };
      }
      if (indent === undefined) indent = ind;
      if (ind.length < indent.length) break;
      if (ind.length > indent.length) continue; // inside labels/annotations
      if (/^[ \t]*<<[ \t]*:/.test(l)) {
        return {
          verdict: 'unchecked',
          reason: 'the metadata block uses a YAML merge key — needs a YAML parser',
        };
      }
      if (keyAtIndent(l, indent, 'name')) {
        const value = topLevelScalar([l.slice(indent.length)], 'name');
        if (value === name) return { verdict: 'defines', line: j + 1 };
        return ABSENT; // this document names something else
      }
    }
  }
  return ABSENT;
}

/** Does this `*.yaml` file hold a document declaring `identifier`? */
export function k8sDefines(text: string, identifier: string): IdentifierMatch {
  const want = parseK8sIdentifier(identifier);
  if ('error' in want) {
    return { verdict: 'unchecked', reason: `not a kubernetes reference (${want.error})` };
  }
  let unchecked: IdentifierMatch | undefined;
  for (const document of splitDocuments(text)) {
    const got = k8sDocumentDefines(document.lines, want.kind, want.name);
    if (got.verdict === 'defines') {
      return { verdict: 'defines', line: got.line + document.offset };
    }
    // One unreadable document does not stop the others from answering; it is
    // only remembered in case none of them does.
    if (got.verdict === 'unchecked') unchecked = got;
  }
  return unchecked ?? ABSENT;
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Does `text` — the contents of a file of the right kind — define
 * `identifier`? The single function resolve.ts codes against, so there is one
 * place where a source is mapped to its matcher.
 */
export function definesIdentifier(
  source: IdentifierSource,
  text: string,
  identifier: string,
): IdentifierMatch {
  switch (source) {
    case 'terraform':
      return terraformDefines(text, identifier);
    case 'compose':
      return composeDefines(text, identifier);
    case 'package':
      return packageDefines(text, identifier);
    case 'k8s-manifest':
      return k8sDefines(text, identifier);
  }
}
