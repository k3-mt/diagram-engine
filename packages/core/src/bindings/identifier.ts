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

/**
 * The one normalisation every matcher below runs first, and the reason it
 * exists: without it a file authored on Windows is read as a file that does
 * not contain what it plainly contains.
 *
 *   CRLF  every line carries a trailing "\r". `^kind[ \t]*:[ \t]*(.*)$` cannot
 *         match it — in JS `.` does not match `\r` and `$` without `m` sits at
 *         the end of the string — so `kind: Deployment\r` read as "not a
 *         manifest at all" and a CORRECT k8s citation came back `missing`,
 *         failing the build. The compose scan failed differently on the same
 *         input: the text after `services:` was `"\r"`, which is not blank, so
 *         the file was reported `unchecked` with the reason "written in flow
 *         style" — a statement about the file that was simply untrue.
 *   BOM   a leading U+FEFF defeats every column-0 anchor, and makes
 *         JSON.parse throw on a package.json that is perfectly valid.
 *
 * Neither changes the line NUMBERING, so evidence lines stay right.
 */
export function normaliseText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, '\n');
}

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
 * Files of the right SUBJECT that the matchers here cannot read.
 *
 * Today that is Terraform's JSON syntax. Excluding `*.tf.json` from the
 * candidate set is right — the HCL patterns cannot read it and guessing is
 * worse than admitting — but it was not carried through to §3.8 rule 1: a
 * repository whose Terraform is written entirely in JSON had zero candidates,
 * took the "no candidate file of the right kind" branch, and had a correct
 * citation reported `missing` with `no *.tf file under the root`. That is a
 * false accusation, and it is textbook rule 2 instead: present, and not
 * readable precisely.
 */
export function isUnreadableCandidateFilename(
  source: IdentifierSource,
  filename: string,
): boolean {
  return source === 'terraform' && filename.toLowerCase().endsWith('.tf.json');
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
 * Why a REF cannot be turned into a pattern at all — a fact about the string
 * the agent wrote, not about any file in the repository.
 *
 * The distinction is the whole point. `unchecked` exists for "this FILE cannot
 * be read precisely"; it is a limit of the tool, it sits outside precision's
 * denominator, and it exits 0. Routing a bad REF there made the honesty number
 * gameable: `terraform=totally-invented-thing`, `terraform=a.b.c.d` and
 * `terraform=each.value` are all decided by the string alone, so an agent
 * could invent citations at will and score `precision 1.0` with an exit code of
 * 0. That is the same loophole ref.ts already closed for `repo=`, and it is
 * closed here the same way: a ref that names nothing a Terraform file can
 * declare is a WRONG CITATION, reported `missing`, and it fails.
 */
export type RefProblem = { reason: string };

/**
 * A Terraform address, turned into what DECLARES it.
 *
 *   aws_ecs_service.orders      resource "aws_ecs_service" "orders" {
 *   aws_ecs_service.orders.id   the same block; the third part is an attribute
 *   module.foo                  module "foo" {
 *   data.aws_ami.ubuntu         data "aws_ami" "ubuntu" {
 *   var.foo                     variable "foo" {
 *   local.foo                   `foo = ...` inside a `locals { ... }` block
 *
 * The block-header pattern is anchored to the start of a line (leading
 * whitespace only) and the names are inside DOUBLE QUOTES, which is what makes
 * it structural rather than a substring. Whitespace between the tokens varies
 * and is allowed to; the quoting does not vary — HCL has no other spelling for
 * a block header.
 *
 * The anchor alone is NOT enough, and an earlier version of this comment
 * claimed it was. A line-start anchor excludes `#` and `//` line comments,
 * because those put a marker before the keyword. It does NOT exclude a line
 * inside a `/* ... *\/` block comment, and it does not exclude a line inside a
 * heredoc body — in both, the text still starts at column 0. Commenting a
 * resource block out with `/* *\/` while leaving it in the file is ordinary
 * Terraform practice, so that gap certified citations to infrastructure that
 * had been deliberately DISABLED. Both are now removed before matching, by
 * stripTerraformNonCode; the anchor is only trusted over text that is known to
 * be code.
 *
 * It deliberately does NOT match:
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
export type TerraformPattern =
  | { ok: true; kind: 'header'; regexp: RegExp }
  | { ok: true; kind: 'local'; name: string }
  | ({ ok: false } & RefProblem);

export function terraformPattern(identifier: string): TerraformPattern {
  const parts = identifier.split('.');
  if (parts.some((p) => p === '')) {
    return { ok: false, reason: 'not a terraform address (empty part)' };
  }
  const q = (s: string) => `"${escapeRegExp(s)}"`;
  const header = (keyword: string, labels: string[]) =>
    new RegExp(`^[ \\t]*${keyword}[ \\t]+${labels.join('[ \\t]+')}[ \\t]*(\\{|$)`, 'm');

  const [first, second, third] = parts as [string, string?, string?];

  // `local.x` names a key inside a `locals { ... }` block. That needs block
  // scope, which no single line regex has — but the block IS delimited, by a
  // brace at the header's own indent, so localsDefines below tracks it the way
  // composeDefines tracks the `services:` block. It used to be `unchecked`,
  // and leaving it there would have kept a whole address family agent-choosable
  // and unfalsifiable.
  if (first === 'local' || first === 'locals') {
    if (second === undefined || third !== undefined) {
      return { ok: false, reason: 'not a terraform local address (want local.NAME)' };
    }
    return { ok: true, kind: 'local', name: second };
  }
  // `each`, `count`, `self` and `path` are expression-time values. Nothing
  // declares them, in this repository or any other, so a citation to one is
  // wrong wherever it is pointed.
  if (first === 'each' || first === 'count' || first === 'self' || first === 'path') {
    return { ok: false, reason: `"${first}" names no declared block, so nothing declares it` };
  }

  if (first === 'var' || first === 'variable') {
    if (second === undefined || third !== undefined) {
      return { ok: false, reason: 'not a terraform variable address (want var.NAME)' };
    }
    return { ok: true, kind: 'header', regexp: header('variable', [q(second)]) };
  }
  if (first === 'output') {
    if (second === undefined || third !== undefined) {
      return { ok: false, reason: 'not a terraform output address (want output.NAME)' };
    }
    return { ok: true, kind: 'header', regexp: header('output', [q(second)]) };
  }
  if (first === 'module') {
    // `module.foo.bar` reads an OUTPUT of module foo. The module block is what
    // the ref ultimately points into, so the header is still the definition.
    if (second === undefined) {
      return { ok: false, reason: 'not a terraform module address (want module.NAME)' };
    }
    return { ok: true, kind: 'header', regexp: header('module', [q(second)]) };
  }
  if (first === 'data') {
    if (second === undefined || third === undefined) {
      return { ok: false, reason: 'not a terraform data address (want data.TYPE.NAME)' };
    }
    return { ok: true, kind: 'header', regexp: header('data', [q(second), q(third)]) };
  }
  if (first === 'resource') {
    // The written-out form `resource.aws_ecs_service.orders`, which is not a
    // real address but is a plausible thing to cite.
    if (second === undefined || third === undefined) {
      return { ok: false, reason: 'not a terraform resource address (want resource.TYPE.NAME)' };
    }
    return { ok: true, kind: 'header', regexp: header('resource', [q(second), q(third)]) };
  }
  // TYPE.NAME, optionally followed by one attribute.
  if (second === undefined) {
    return { ok: false, reason: 'not a terraform address (want TYPE.NAME)' };
  }
  if (parts.length > 3) {
    return { ok: false, reason: 'not a terraform address (too many parts)' };
  }
  return { ok: true, kind: 'header', regexp: header('resource', [q(first), q(second)]) };
}

/**
 * Blank out everything in a `.tf` file that is not HCL code, preserving the
 * line numbering so an evidence line still points where a human should look.
 *
 * Three regions, and each one was a route to a FALSE `ok`:
 *   - `#` and `//` to end of line. (Already excluded by the line anchor; done
 *     here too so there is one rule rather than two.)
 *   - `/* ... *\/`, which spans lines and leaves the text it wraps at column 0.
 *     A commented-out `resource "aws_ecs_service" "orders" {` was reported
 *     `defined in main.tf:2`.
 *   - a heredoc body (`<<EOT` / `<<-EOT`), which is STRING DATA, not HCL. An
 *     embedded template, a doc string, or a local-exec script that writes a .tf
 *     file could contain a resource header and certify a citation the file does
 *     not declare.
 *
 * Double-quoted strings are TRACKED but not blanked: the header pattern needs
 * `"aws_ecs_service"` to still be there. Tracking them is what stops a `#` or a
 * `<<` inside a string from being read as the start of a comment or a heredoc.
 * String state is reset at every newline, because an HCL quoted string cannot
 * span one — so the blast radius of mis-tracking a quote is a single line.
 *
 * An unterminated `/*` or heredoc means the file is not readable as HCL, and
 * that is an honest `unchecked` (rule 2) rather than a guess in either
 * direction.
 */
export function stripTerraformNonCode(
  text: string,
): { ok: true; text: string } | ({ ok: false } & RefProblem) {
  const lines = text.split('\n');
  const out: string[] = [];
  let inBlockComment = false;
  let heredoc: { term: string; indented: boolean } | undefined;

  for (const line of lines) {
    if (heredoc !== undefined) {
      // The body and the terminator line are both blanked: neither is code,
      // and an empty line keeps the numbering exact.
      const terminator = heredoc.indented
        ? new RegExp(`^[ \\t]*${escapeRegExp(heredoc.term)}[ \\t]*$`)
        : new RegExp(`^${escapeRegExp(heredoc.term)}[ \\t]*$`);
      out.push('');
      if (terminator.test(line)) heredoc = undefined;
      continue;
    }
    let result = '';
    let inString = false;
    let i = 0;
    while (i < line.length) {
      const c = line[i] as string;
      if (inBlockComment) {
        if (c === '*' && line[i + 1] === '/') {
          inBlockComment = false;
          result += '  ';
          i += 2;
          continue;
        }
        result += ' ';
        i += 1;
        continue;
      }
      if (inString) {
        if (c === '\\') {
          result += line.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === '"') inString = false;
        result += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        inString = true;
        result += c;
        i += 1;
        continue;
      }
      if (c === '#' || (c === '/' && line[i + 1] === '/')) break; // rest of the line is a comment
      if (c === '/' && line[i + 1] === '*') {
        inBlockComment = true;
        result += '  ';
        i += 2;
        continue;
      }
      if (c === '<' && line[i + 1] === '<') {
        const m = /^<<(-?)("?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(i));
        if (m !== null) {
          heredoc = { term: m[3] as string, indented: m[1] === '-' };
          result += ' '.repeat(m[0].length);
          i += m[0].length;
          continue;
        }
      }
      result += c;
      i += 1;
    }
    out.push(result);
  }

  if (inBlockComment) {
    return { ok: false, reason: 'an unterminated /* block comment — not readable as HCL' };
  }
  if (heredoc !== undefined) {
    return { ok: false, reason: `an unterminated <<${heredoc.term} heredoc — not readable as HCL` };
  }
  return { ok: true, text: out.join('\n') };
}

/**
 * Is `name` a key of a `locals { ... }` block?
 *
 * Bounded the way composeDefines bounds the `services:` mapping, and for the
 * same reason — the alternative is `unchecked` for every `local.*` citation,
 * which is a whole address family the checker never verifies:
 *
 *   1. a line that is exactly `locals {` (leading whitespace allowed, nothing
 *      but a comment after the brace; anything else is `unchecked`).
 *   2. the block ends at the first line that is `}` at the header's own indent.
 *      No such line -> `unchecked`: we do not know where the block stopped.
 *   3. inside it, the KEYS are the lines at the block's own indent, taken from
 *      its first non-blank line. Deeper lines belong to a value (a map, a
 *      list), never to `locals`.
 *
 * A key is `name =` or `"name" =`. `=` rather than `:` is what makes this a
 * declaration and not a use: `orders = local.orders` declares once and reads
 * once, and only the left-hand side is at the block indent followed by `=`.
 */
export function localsDefines(text: string, name: string): IdentifierMatch {
  const lines = text.split('\n');
  const key = new RegExp(`^(?:${escapeRegExp(name)}|"${escapeRegExp(name)}")[ \\t]*=(?!=)`);
  let deferred: IdentifierMatch | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const head = /^([ \t]*)locals[ \t]*\{[ \t]*$/.exec(line);
    if (head === null) {
      if (/^[ \t]*locals[ \t]*\{/.test(line)) {
        deferred ??= {
          verdict: 'unchecked',
          reason: 'a locals block is written on one line — needs an HCL parser',
        };
      }
      continue;
    }
    const outer = head[1] as string;
    const close = new RegExp(`^${escapeRegExp(outer)}\\}[ \\t]*$`);
    let indent: string | undefined;
    let closed = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j] as string;
      if (close.test(l)) {
        closed = true;
        break;
      }
      if (BLANK_OR_COMMENT.test(l)) continue;
      const ind = indentOf(l);
      if (indent === undefined) {
        if (ind.length <= outer.length) {
          deferred ??= {
            verdict: 'unchecked',
            reason: 'the locals block is not indented — cannot tell its keys from its values',
          };
          break;
        }
        indent = ind;
      }
      if (ind.length < indent.length) {
        deferred ??= {
          verdict: 'unchecked',
          reason: 'the locals block dedents before it closes — needs an HCL parser',
        };
        break;
      }
      if (ind.length > indent.length) continue; // inside one local's value
      if (key.test(l.slice(indent.length))) return { verdict: 'defines', line: j + 1 };
    }
    if (!closed && indent !== undefined) {
      deferred ??= {
        verdict: 'unchecked',
        reason: 'a locals block is never closed — not readable as HCL',
      };
    }
  }
  return deferred ?? ABSENT;
}

/**
 * Does this `.tf` file declare this address?
 *
 * The ref-shape refusals do NOT arrive here as `unchecked`: resolve.ts asks
 * terraformRefProblem once, before it opens anything, so a defect in the ref
 * is never reported against a file that is perfectly fine. This function keeps
 * returning `unchecked` for them so that the pure API is total, but on the
 * checker's path that branch is unreachable.
 */
export function terraformDefines(text: string, identifier: string): IdentifierMatch {
  const pattern = terraformPattern(identifier);
  if (!pattern.ok) return { verdict: 'unchecked', reason: pattern.reason };
  const stripped = stripTerraformNonCode(normaliseText(text));
  if (!stripped.ok) return { verdict: 'unchecked', reason: stripped.reason };
  if (pattern.kind === 'local') return localsDefines(stripped.text, pattern.name);
  const m = pattern.regexp.exec(stripped.text);
  if (m === null) return ABSENT;
  return { verdict: 'defines', line: lineAt(stripped.text, m.index) };
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

/**
 * The three spellings of one YAML mapping key: `name`, `"name"`, `'name'`.
 *
 * Factored out because the two helpers that need it drifted: keyAtIndent
 * accepted all three and topLevelScalar accepted only the bare one, so
 * `  "name": orders` passed the key test and then read as having no value at
 * all — and the document was reported as naming something else, turning a
 * correct citation into `missing`. One expression, one answer.
 */
function keyAlternation(key: string): string {
  const k = escapeRegExp(key);
  return `(?:${k}|"${k}"|'${k}')`;
}

/** A mapping key, bare or quoted: `orders-api:`, `"orders-api":`, `'x':`. */
function keyAtIndent(line: string, indent: string, key: string): boolean {
  return new RegExp(`^${escapeRegExp(indent)}${keyAlternation(key)}[ \\t]*:`).test(line);
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
  const lines = normaliseText(text).split('\n');
  // A reason we may end up giving, remembered rather than returned: a merge key
  // can only ADD services, never remove one, so a key found literally in the
  // block is a definition whatever the anchor contributes. Returning at the
  // `<<:` made the verdict depend on line ORDER — the same file with the
  // service listed above the merge key answered `defines` and below it
  // answered `unchecked`.
  let deferred: IdentifierMatch | undefined;

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
        deferred ??= {
          verdict: 'unchecked',
          reason: 'the services block uses a YAML merge key — needs a YAML parser',
        };
        continue;
      }
      // No mixed-indent branch here. Both strings reached this line without a
      // tab and with equal length, so they are the same string; the check that
      // used to sit here could not fire.
      if (keyAtIndent(l, indent, name)) return { verdict: 'defines', line: j + 1 };
    }
  }
  return deferred ?? ABSENT;
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
export function packageDefines(rawText: string, name: string): IdentifierMatch {
  // A BOM is legal in a file a Windows editor wrote and makes JSON.parse throw,
  // which reported a perfectly valid package.json as "not valid JSON".
  const text = normaliseText(rawText);
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
  const re = new RegExp(`^${keyAlternation(key)}[ \\t]*:[ \\t]*(.*)$`);
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
      // (No mixed-indent branch: see composeDefines. Equal length, no tab,
      // means the same string.)
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
  for (const document of splitDocuments(normaliseText(text))) {
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
/**
 * Can this REF be turned into a pattern at all — before any file is opened?
 *
 * Returns the reason when it cannot. resolve.ts calls this once per binding and
 * reports `missing` on a reason, which is what keeps precision honest: every
 * condition below is a property of the string the agent wrote, so routing them
 * to `unchecked` (outside precision's denominator, exit 0) let an agent invent
 * citations for free. It also stops the report from blaming whichever candidate
 * file happened to sort first for a defect that is not in any file.
 *
 * `compose` and `package` have no such conditions: any non-blank string is a
 * legal service key and a legal package name, and V16 already rejects blanks.
 */
export function identifierRefProblem(
  source: IdentifierSource,
  identifier: string,
): string | undefined {
  switch (source) {
    case 'terraform': {
      const pattern = terraformPattern(identifier);
      return pattern.ok ? undefined : pattern.reason;
    }
    case 'k8s-manifest': {
      const want = parseK8sIdentifier(identifier);
      return 'error' in want ? `not a kubernetes reference (${want.error})` : undefined;
    }
    case 'compose':
    case 'package':
      return undefined;
  }
}

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
