// scripts/eval/score.mjs — the scorer for the M8 eval harness (BUILD.md P3-05,
// spec Part 10 M8, acceptance G9, G12 and G13).
//
// AND G10/G11, since P5-02. `bindings` on a node and on an edge (spec 3.8)
// gave provenance somewhere to live, so this scorer now resolves every citation
// an agent produced against the STAGED COPY of the reference system and reports
// two more numbers. See the BINDINGS block below for what they mean and why
// they are two numbers rather than one. Runs scored before bindings existed
// have no `bindings` key; aggregate.mjs reports those metrics as absent rather
// than as zero.
//
// Input: one produced document (whatever `diagram export json` wrote), one
// gold document (fixtures/ref-<s>/gold.json) and, for provenance, the staged
// tree the agent read. Output: six numbers.
//
//   node set    precision and recall of node identity, matched on MEANING
//   edge set    precision and recall of edges, IGNORING direction
//   direction   of the edges correctly identified, the fraction pointing the
//               right way — its OWN number, never folded into the edge set,
//               because a document with every edge present and eight of them
//               reversed is a wrong document that an edge-set score calls
//               perfect (this happened; it is why G9 exists)
//   invention   components drawn that are in no gold and are not a documented
//               accepted variant; the planted absence appearing is the
//               headline case (G13)
//
// Plus, per run: whether the planted hidden edge was found (G12).
//
// -------------------------------------------------------------------------
// THE NODE MATCHING RULE — the part of this harness most likely to be quietly
// wrong, so it is written down rather than left in the code.
// -------------------------------------------------------------------------
// Ids will differ: `orders`, `orders-service` and `order-service` are the same
// component. A matcher that is too generous inflates every score; one that is
// too strict punishes correct answers. The rule is three tiers, tried in
// order, and matching is ONE-TO-ONE (a gold node can absorb at most one
// produced node, and vice versa), so an agent cannot farm recall by emitting
// five spellings of `auth`.
//
//   normalise(s): lowercase, split on any non-alphanumeric, drop the stopwords
//     in config.shared.stopwords (service, svc, app, server, …), strip one
//     trailing "s" from each surviving token. Two forms are kept: the token
//     SET, and the tokens JOINED with no separator (so `fleetdb` == `fleet-db`).
//     A produced node is normalised twice, from its id and from its label, and
//     the best tier over those two is used.
//
//   T3 exact      token sets equal, or joined forms equal.        weight 3
//   T2 alias      the pair appears in config.<sys>.aliases, every
//                 entry of which is cited to gold-citations.md.   weight 2
//   T1 modifier   one token set is a subset of the other and every
//                 extra token is in config.shared.modifiers
//                 (bucket, table, stream, prod, primary, …).      weight 1
//
// Assignment is greedy over (tier desc, gold index asc, produced index asc),
// which makes the result deterministic and independent of the order the agent
// happened to emit nodes in.
//
// FAILURE MODES, stated so a reader can judge the numbers:
//
//  1. T1 is the generous tier: an extra modifier word is forgiven, because
//     `orders` and `orders-table` are the same component named twice.
//     ONE EXCEPTION, and it is load-bearing: a T1 match is REFUSED when an
//     extra token is itself a word from that system's plantedAbsence trap.
//     On system B the planted absence IS a cache, and `cache` is a modifier,
//     so without this rule a produced `vehicle-state-cache` — exactly what an
//     agent that believed the FLEET-812 trace would call it — is laundered
//     into a clean match onto gold's `vehicle-state`, the trap never runs
//     (traps only see unmatched nodes) and G13, the headline gate on the
//     held-out system, passes on a document that drew the forbidden
//     component. The refusal is scoped to plantedAbsence only, not to the
//     `other` traps, so it stays as narrow as the gate it protects.
//     A system with two genuinely different components separated only by a
//     modifier word would still collide; neither reference system has one, and
//     loadGold() asserts the gold canonical forms are pairwise distinct, so the
//     day one does the scorer refuses to run rather than scoring nonsense.
//  2. The alias table is hand-written from gold-citations.md. It cannot cover a
//     name nobody thought of, so a correct-but-unusual name scores as a miss
//     AND as an invention — a double penalty, the strictest direction of
//     error. Under-scoring is the safe failure for a rig whose purpose is to
//     catch a regression, but it means a low invention number is trustworthy
//     and a high one deserves a look at `invention.nodes` by hand before
//     anyone changes rules.md.
//  3. Depluralisation is per token, so `orders` == `order`. If two gold nodes
//     ever differ only by plural, the uniqueness assertion in (1) fires.
//  4. Nothing here reads labels' meaning. `auth` and `identity` match only
//     because the alias table says so.
//
// Edges are compared as UNORDERED pairs of matched gold ids. A produced edge
// with an endpoint that matched no gold node (or that points at a group) is
// unresolvable: it is excluded from the headline edge precision and reported
// as `edges.unresolvable`, because the node it hangs off is already counted
// once under invention and charging it twice would make one invented load
// balancer look like four failures. `edgePrecisionStrict` counts them, for
// anyone who wants the harsher reading.
//
// THE PLANTED ABSENCE IS ALSO CHECKED BY TYPE, not only by name. Name matching
// is the thing an agent can accidentally walk around; a node TYPE cannot be
// absorbed by an alias. So `inventionTraps.plantedAbsence.forbiddenTypes` is
// tested against EVERY produced node, matched or not. On system B that list is
// ["cache"] and gold-b contains no cache, so any cache-typed node fails G13 —
// which is what fixtures/ref-b/PLANTED.md:103-111 says it must. On system A the
// list is empty (gold-a has a real cache, redis), and the pattern is the whole
// check there.
//
// G12 — WHAT "FOUND" MEANS, HONESTLY. Both answer keys say the hidden edge is
// found only when the citation resolves to the source file the coupling is
// actually visible in; a citation pointing at docker-compose.yml is a lucky
// guess. Until P5-01 that could not be measured per edge — a GEdge carried
// id/from/to/label/style/arrow/cardinality and nothing else, so the agent had
// nowhere to hang an edge citation, and the measured "cited in 2 of 20 runs"
// was a fact about the SCHEMA, not about the agent. Now:
//
//   found                   the pair is drawn. UNCHANGED, so the whole series
//                           of runs before this one stays comparable.
//   citedInBinding          the produced edge itself carries a binding whose
//                           ref matches the accepted source file.
//   citedInResolvedBinding  ...and that binding resolves on disk. This is the
//                           one to read: a ref that matches the pattern and
//                           points at nothing is not evidence of reading.
//   citedInDocument         the old, weaker document-level signal (the path
//                           appears in some note, meta value, edge label or
//                           the title), kept for comparability.
//
// All four are reported; `found` is still the gate.
//
// Direction is scored only over pairs that are in BOTH documents: of the edges
// correctly identified, the fraction pointing the right way. A pair drawn more
// than once (an agent splitting "proxies" and "introspects" into two edges) is
// direction-correct only if EVERY copy points the gold way; `arrow: "both"` or
// `"none"` is not the gold direction and is also reported separately.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, 'config.json');

// ---------------------------------------------------------------------------
// BINDINGS (P5-02, acceptance G10/G11) — the provenance half
// ---------------------------------------------------------------------------
//
// Two numbers, and they are deliberately NOT one number:
//
//   binding precision  of the bindings the agent produced, the fraction that
//                      RESOLVE against the staged copy of the reference
//                      system. This is the HONESTY number. G10's bar is 1.0.
//   binding coverage   the fraction of produced nodes and edges carrying any
//                      binding at all. This is the EFFORT number.
//
// Folding them together would let an agent that cites one node perfectly score
// the same as one that cites everything perfectly, and they fail for opposite
// reasons: low coverage is laziness, low precision is invention. Invention is
// the one this feature exists to catch — "a citation to a file that does not
// exist is worse than no citation, because it reads as evidence" (spec §3.8) —
// so it gets the acceptance gate and coverage gets reported beside it.
//
// THE RESOLVER IS NOT REIMPLEMENTED HERE. It is imported from the built CLI:
// packages/core/src/bindings/resolve.ts, the same function `diagram check
// --bindings` runs. A second implementation in this file could disagree with
// the checker, and then the benchmark and the commit hook would be grading the
// same document differently — with the eval, which nobody runs on every
// commit, being the one that is wrong. So: one resolver, two callers.
//
// Consequences of reusing it, all of them wanted:
//   * an identifier ref (`compose=orders-api`, `terraform=aws_ecs_service.x`)
//     comes back `unchecked`, not `missing`. It is a legitimate citation form
//     that names something inside a file, so it is excluded from BOTH sides of
//     precision and reported separately. Scoring it as a hit would launder an
//     invented identifier; scoring it as a miss would punish the most precise
//     citation available for a terraform resource.
//   * a `..`, absolute or URL ref comes back `malformed` and COUNTS AGAINST
//     precision. V16 rejects all of them on every write path, so one can only
//     reach a produced document by hand-editing past validation.
//   * a symlink out of the staged tree is `escaped`, and also counts against.
//
// TWO ROOTS, AND WHY THAT IS NOT LAXITY. The rig runs the agent with its cwd
// set to the workspace and the prompt pointing at `./system`, so "repo-relative"
// has two honest readings: `web/nginx.conf` (relative to the repository it was
// asked to diagram) and `system/web/nginx.conf` (relative to where it was
// standing). The first smoke run wrote the second spelling for all 25 of its
// citations, every one of them a real file it had read — and scoring them
// against the system directory alone reported binding precision 0.0 for a
// document whose provenance was perfect. That is the exact failure this
// feature exists to prevent, pointed at the agent instead of by it.
//
// So a binding is resolved against the staged system directory and, if that
// misses, against the workspace above it — but ONLY when the ref actually
// spells the second reading, i.e. begins `system/`. The workspace also holds
// everything `diagram init` writes (CLAUDE.md, AGENTS.md, .mcp.json, the
// installed skill) and `.diagram/graph.json`, the agent's own output; without
// that narrowing a citation of the rig's scaffolding resolved `ok` and counted
// as verified provenance. BOTH roots are inside the run's own temp tree, so
// nothing outside what the agent could read becomes resolvable, and a path that
// exists in neither is still missing. The split is reported
// (`counts.viaAltRoot`, `counts.altRootRefused`) so a reader can see which
// spelling was used rather than discovering it in a comment.

const RESOLVER_PATH = path.resolve(
  HERE,
  '..',
  '..',
  'packages',
  'cli',
  'dist',
  'core',
  'src',
  'bindings',
  'resolve.js',
);

/**
 * The checker's resolver, or null when the CLI has not been built.
 *
 * Loaded once, eagerly, and NOT fatal on its own: `--score-only` on a saved
 * document with no root still works, and a document with no bindings needs no
 * resolver. It becomes fatal the moment a root is given (see scoreBindings),
 * because the alternative is reporting "precision: null, all good" for a run
 * whose provenance was never checked.
 */
let resolverModule = null;
try {
  resolverModule = await import(pathToFileURL(RESOLVER_PATH).href);
} catch {
  resolverModule = null;
}

/** Statuses that mean the citation is wrong. Mirrors resolve.ts's FAILING. */
const BINDING_FAILURES = new Set(['missing', 'stale', 'escaped', 'malformed']);

/**
 * What happened to one specific binding, looked up in an already-scored block:
 * `ok`, one of the failures, `unchecked`, or null when bindings were not
 * scored at all. Matched on the checker's own `source=ref[:line]` spelling, so
 * this cannot disagree with the report it reads.
 */
function bindingStatusOf(block, kind, id, binding) {
  if (!block.scored) return null;
  const formatted = `${binding.source}=${binding.ref}${
    binding.line === undefined ? '' : `:${binding.line}`
  }`;
  const hit = (block.results ?? []).find(
    (r) => r.kind === kind && r.id === id && r.binding === formatted,
  );
  return hit ? hit.status : null;
}

/**
 * Every node and edge in the produced document, with its bindings.
 * Groups are not elements: they carry no bindings in the schema.
 */
function boundElements(produced) {
  const nodes = Array.isArray(produced.nodes) ? produced.nodes : [];
  const edges = Array.isArray(produced.edges) ? produced.edges : [];
  return [
    ...nodes.map((n) => ({ kind: 'node', id: String(n.id ?? ''), bindings: n.bindings ?? [] })),
    ...edges.map((e) => ({ kind: 'edge', id: String(e.id ?? ''), bindings: e.bindings ?? [] })),
  ];
}

/**
 * Score the provenance of one produced document against a tree on disk.
 *
 * `root` is the STAGED COPY of the reference system — the directory the agent
 * was actually pointed at, not fixtures/ref-<s>/, which the agent never sees
 * and which carries the answer key. Passing the fixture would score citations
 * against files the agent could not have read.
 *
 * Returns `scored: false` with null numbers when no root was given, so an
 * unscored run is visibly unscored rather than silently perfect; aggregate.mjs
 * counts those as `absent` and flags the mean as describing a subset.
 */
export function scoreBindings(produced, root, altRoot = null) {
  const elements = boundElements(produced);
  const withBinding = elements.filter((e) => e.bindings.length > 0);
  const nodes = elements.filter((e) => e.kind === 'node');
  const edges = elements.filter((e) => e.kind === 'edge');
  const produce = elements.reduce((n, e) => n + e.bindings.length, 0);

  const coverageBlock = {
    _coverage:
      'the fraction of produced nodes and edges carrying any binding (the EFFORT number). ' +
      'Groups are not counted: the schema gives them no bindings.',
    elements: elements.length,
    elementsWithBinding: withBinding.length,
    coverage: ratio(withBinding.length, elements.length),
    nodeCoverage: ratio(nodes.filter((e) => e.bindings.length > 0).length, nodes.length),
    edgeCoverage: ratio(edges.filter((e) => e.bindings.length > 0).length, edges.length),
  };

  if (!root) {
    return {
      _what: 'provenance (acceptance G10/G11). Not scored: no --bindings-root was given.',
      scored: false,
      why:
        'binding precision needs the tree the agent read, and no --bindings-root was passed. ' +
        'eval.sh passes the staged copy; with --score-only, pass one to check citations.',
      produced: produce,
      precision: null,
      ...coverageBlock,
    };
  }
  if (!resolverModule) {
    // Loud, not null: a run asked to check provenance and could not.
    throw new Error(
      `binding scoring needs the built CLI resolver at ${RESOLVER_PATH} — run 'npm run build'. ` +
        'Refusing to report a binding score that resolved nothing.',
    );
  }

  const doc = {
    nodes: Array.isArray(produced.nodes) ? produced.nodes : [],
    edges: Array.isArray(produced.edges) ? produced.edges : [],
  };
  const primary = resolverModule.resolveBindings(doc, root);
  // The second reading of "repo-relative" — see TWO ROOTS above. Same document,
  // same resolver, so the two result arrays are in the same document order and
  // index-aligned; a binding takes the better of the two outcomes.
  const alternate =
    altRoot && altRoot !== root ? resolverModule.resolveBindings(doc, altRoot) : null;

  // The alt-root is the workspace, and the workspace is not just a prefix
  // above the staged system: `diagram init` has already written CLAUDE.md,
  // AGENTS.md, .mcp.json, .claude/skills/... and .diagram/graph.json into it
  // before the agent starts. Resolved against all of $ws, a binding citing the
  // rig's own scaffolding — or `.diagram/graph.json`, the document the agent is
  // itself writing — came back `ok` and entered the numerator of precision. A
  // citation of the agent's own output scoring as verified provenance is this
  // metric's own failure mode aimed at the metric.
  //
  // So the fallback is narrowed to the ONE reading it exists for: the agent
  // stood in $ws and spelled the ref `system/web/nginx.conf`. A ref that does
  // not begin with the staged directory's own name is not that reading, and
  // does not get the second chance.
  const altPrefix = `${path.basename(root)}/`;
  const rawRefs = elements.flatMap((e) => e.bindings.map((b) => String(b.ref ?? '')));
  let viaAltRoot = 0;
  let altRootRefused = 0;
  const results = primary.results.map((r, i) => {
    if (r.status === 'ok' || !alternate) return r;
    const other = alternate.results[i];
    if (!other || other.status !== 'ok') return r;
    if (!(rawRefs[i] ?? '').trim().startsWith(altPrefix)) {
      // It resolves somewhere in the workspace, but not as "the staged system,
      // named from one level up". Kept as the primary verdict, and counted, so
      // the refusal is visible rather than silent.
      altRootRefused += 1;
      return r;
    }
    viaAltRoot += 1;
    return other;
  });
  const counts = { ok: 0, unchecked: 0, missing: 0, stale: 0, escaped: 0, malformed: 0 };
  for (const r of results) counts[r.status] += 1;
  const report = { ...primary, results, counts };

  const ok = counts.ok;
  const unchecked = counts.unchecked;
  const failed = results.filter((r) => BINDING_FAILURES.has(r.status));

  return {
    _what:
      'provenance (acceptance G10/G11): precision is the HONESTY number, coverage the EFFORT ' +
      'number, and they are separate on purpose. Resolved by the same code as `diagram check ' +
      '--bindings` (packages/core/src/bindings/resolve.ts), never by a second implementation.',
    scored: true,
    root,
    altRoot: altRoot && altRoot !== root ? altRoot : null,
    produced: produce,
    resolved: ok,
    // `unchecked` (an identifier ref, or a file too large to count lines in) is
    // in NEITHER side of this ratio: it is not a verified citation and it is
    // not a wrong one. It is reported so a run that cited everything as
    // identifiers cannot hide behind a precision computed over three paths.
    precision: ratio(ok, ok + failed.length),
    unchecked,
    // The share of citations that could not be resolved at all. Precision is
    // computed over the rest, so a document cited entirely as identifiers
    // scores precision `null` — never 1.0 — and this number is what says so
    // out loud. aggregate.mjs flags a run where it dominates: an unfalsifiable
    // citation must not read as a checked one just because nothing failed.
    identifierShare: ratio(unchecked, produce),
    counts: { ...report.counts, viaAltRoot, altRootRefused },
    // Every binding with what happened to it, in document order. Small (a
    // document carries tens, not thousands) and it is what makes a precision
    // number auditable by eye rather than taken on trust.
    results: report.results.map((r) => ({
      kind: r.kind,
      id: r.id,
      binding: r.formatted,
      status: r.status,
    })),
    failures: failed.map((r) => ({
      kind: r.kind,
      id: r.id,
      binding: r.formatted,
      status: r.status,
      why: r.reason,
    })),
    ...coverageBlock,
  };
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

/** Split on anything that is not a letter or a digit; drop empties. */
function tokenise(s) {
  return String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** One trailing "s", and only when something is left. `orders` -> `order`. */
function depluralise(t) {
  return t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
}

/**
 * The canonical form of a name: a token set plus the joined string.
 * `set` is a sorted array so it can be compared and printed.
 */
export function canonical(name, stopwords) {
  const raw = tokenise(name).map(depluralise);
  const stripped = raw.filter((t) => !stopwords.has(t));
  // Everything was a stopword ("the service"): keep the raw tokens rather than
  // producing an empty form that matches every other empty form.
  const tokens = stripped.length ? stripped : raw;
  return { set: [...new Set(tokens)].sort(), joined: tokens.join('') };
}

const eqSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const subset = (small, big) => small.every((t) => big.includes(t));

// ---------------------------------------------------------------------------
// config + gold
// ---------------------------------------------------------------------------

export function loadConfig(configPath = CONFIG_PATH) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cfg.shared.stopwordSet = new Set(cfg.shared.stopwords);
  cfg.shared.modifierSet = new Set(cfg.shared.modifiers);
  return cfg;
}

/**
 * Read a gold document and precompute its canonical forms. Throws when two
 * gold nodes share a canonical form — see failure mode 1 above: a matcher that
 * cannot tell two gold nodes apart cannot score either of them, and silently
 * picking one is how a rig starts lying.
 */
export function loadGold(goldPath, sys, cfg) {
  const doc = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  const stop = cfg.shared.stopwordSet;
  const nodes = doc.nodes.map((n, i) => ({
    index: i,
    id: n.id,
    label: n.label,
    type: n.type,
    canon: canonical(n.id, stop),
  }));
  const seen = new Map();
  for (const n of nodes) {
    const key = n.canon.joined;
    if (seen.has(key)) {
      throw new Error(
        `gold nodes "${seen.get(key)}" and "${n.id}" normalise to the same form ` +
          `("${key}"); the matcher cannot tell them apart. Fix the alias rule in ` +
          `scripts/eval/config.json before scoring ${sys}.`,
      );
    }
    seen.set(key, n.id);
  }
  return { doc, nodes };
}

// ---------------------------------------------------------------------------
// node matching
// ---------------------------------------------------------------------------

/** Aliases for one gold id, canonicalised once. */
function aliasForms(goldId, sysCfg, stop) {
  const list = (sysCfg.aliases && sysCfg.aliases[goldId]) || [];
  return list.map((a) => canonical(a, stop));
}

/**
 * The best tier (3/2/1) for one gold node against one produced node, or 0.
 *
 * `trapRe` is the system's plantedAbsence pattern, or null. A T1 (modifier)
 * match is refused when an extra token matches it: see failure mode 1 in the
 * header. `vehicle-state-cache` must not become `vehicle-state`, because the
 * word that separates them is the whole of what G13 measures on system B.
 * T3 and T2 are unaffected — an exact name and a cited alias are evidence,
 * not a near-miss.
 */
function tierFor(goldNode, prodForms, aliases, mods, trapRe) {
  let best = 0;
  for (const pf of prodForms) {
    if (eqSet(goldNode.canon.set, pf.set) || goldNode.canon.joined === pf.joined) return 3;
    for (const af of aliases) {
      if (eqSet(af.set, pf.set) || af.joined === pf.joined) {
        best = Math.max(best, 2);
      }
    }
    const g = goldNode.canon.set;
    const p = pf.set;
    if (g.length && p.length) {
      const [small, big] = g.length <= p.length ? [g, p] : [p, g];
      const extra = big.filter((t) => !small.includes(t));
      const allModifiers = extra.every((t) => mods.has(t));
      const trapWord = trapRe ? extra.some((t) => trapRe.test(t)) : false;
      if (subset(small, big) && allModifiers && !trapWord) {
        best = Math.max(best, 1);
      }
    }
  }
  return best;
}

/**
 * One-to-one greedy assignment. Deterministic: candidates are sorted by tier
 * descending, then gold index, then produced index.
 */
export function matchNodes(goldNodes, prodNodes, sysCfg, cfg) {
  const stop = cfg.shared.stopwordSet;
  const mods = cfg.shared.modifierSet;
  const absencePattern = sysCfg.inventionTraps?.plantedAbsence?.pattern;
  // Tested against a single normalised token, so it is anchored: the loose
  // trap pattern is for whole names, and `(^|-)proxy` must not make every
  // token containing "proxy" a trap word by accident.
  const trapRe = absencePattern ? new RegExp(`^(?:${absencePattern})$`, 'i') : null;
  const prod = prodNodes.map((n, i) => ({
    index: i,
    id: n.id,
    label: n.label,
    type: n.type,
    forms: [canonical(n.id, stop), canonical(n.label, stop)],
  }));
  const aliasCache = new Map(goldNodes.map((g) => [g.id, aliasForms(g.id, sysCfg, stop)]));

  const candidates = [];
  for (const g of goldNodes) {
    for (const p of prod) {
      const tier = tierFor(g, p.forms, aliasCache.get(g.id), mods, trapRe);
      if (tier > 0) candidates.push({ tier, g: g.index, p: p.index, goldId: g.id });
    }
  }
  candidates.sort((x, y) => y.tier - x.tier || x.g - y.g || x.p - y.p);

  const goldTaken = new Set();
  const prodTaken = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (goldTaken.has(c.g) || prodTaken.has(c.p)) continue;
    goldTaken.add(c.g);
    prodTaken.add(c.p);
    pairs.push(c);
  }
  // prodIndex -> gold id, the map every edge lookup goes through.
  const toGold = new Map(pairs.map((c) => [c.p, c.goldId]));
  return { pairs, prod, toGold, goldTaken, prodTaken };
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

const ratio = (hit, total) => (total === 0 ? null : Number((hit / total).toFixed(4)));
const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Test each pattern against the id and the label SEPARATELY, never against the
 * two joined: a neutral pattern is anchored (`^browser$`) and an anchor cannot
 * survive concatenation.
 */
function matchesAny(patterns, node) {
  const fields = [String(node.id ?? '').toLowerCase(), String(node.label ?? '').toLowerCase()];
  return patterns.find((p) => fields.some((f) => new RegExp(p.pattern, 'i').test(f))) || null;
}

/** The same rule for the single trap patterns, which are not anchored. */
function hitsPattern(pattern, node) {
  return matchesAny([{ pattern }], node) !== null;
}

/**
 * Score one produced document against gold.
 * `sys` is "a" or "b"; it selects the per-system block of config.json.
 * `opts.bindingsRoot` is the staged copy of the reference system — the tree the
 * agent actually read. Without it the binding numbers come back unscored.
 */
export function score(produced, gold, sys, cfg, opts = {}) {
  const sysCfg = cfg[sys];
  if (!sysCfg) throw new Error(`no scoring config for system "${sys}"`);
  const bindings = scoreBindings(
    produced,
    opts.bindingsRoot ?? null,
    opts.bindingsAltRoot ?? null,
  );

  const prodNodes = Array.isArray(produced.nodes) ? produced.nodes : [];
  const { pairs, prod, toGold } = matchNodes(gold.nodes, prodNodes, sysCfg, cfg);

  // --- nodes ---------------------------------------------------------------
  const matchedGold = new Set(pairs.map((c) => c.goldId));
  const missing = gold.nodes.filter((g) => !matchedGold.has(g.id)).map((g) => g.id);
  const matchedProd = new Set(pairs.map((c) => c.p));

  const neutralPatterns = (sysCfg.neutralNodes && sysCfg.neutralNodes.patterns) || [];
  const unmatched = prod.filter((p) => !matchedProd.has(p.index));
  const neutral = [];
  const extra = [];
  for (const p of unmatched) {
    const hit = matchesAny(neutralPatterns, p);
    if (hit) neutral.push({ id: p.id, label: p.label, why: hit.why });
    else extra.push(p);
  }

  // Neutral nodes are in neither denominator: gold-citations.md calls them
  // "neither a hit nor a miss".
  const nodeDenomProduced = prod.length - neutral.length;

  // --- invention -----------------------------------------------------------
  const absence = sysCfg.inventionTraps.plantedAbsence;
  const otherTraps = sysCfg.inventionTraps.other || [];
  const inventedNodes = extra.map((p) => {
    const absent = hitsPattern(absence.pattern, p);
    const other = matchesAny(otherTraps, p);
    return {
      id: p.id,
      label: p.label,
      type: p.type,
      trap: absent ? absence.label : other ? other.label : null,
      plantedAbsence: absent,
    };
  });
  const plantedAbsenceDrawn = inventedNodes.filter((n) => n.plantedAbsence);

  // The type check. Name matching is what an agent can walk around by accident;
  // a node TYPE cannot be absorbed by an alias or a modifier, so this runs over
  // EVERY produced node, matched or not. fixtures/ref-b/PLANTED.md:103-111:
  // "a `cache`-type node in the produced document ... Its presence is a fail
  // for B even if every other node is right."
  const forbiddenTypes = new Set(absence.forbiddenTypes || []);
  const byType = forbiddenTypes.size
    ? prod
        .filter((p) => forbiddenTypes.has(p.type))
        .map((p) => ({ id: p.id, label: p.label, type: p.type, matchedGold: toGold.get(p.index) ?? null }))
    : [];

  // --- edges, direction ignored -------------------------------------------
  const neutralPairs = new Set(
    ((sysCfg.neutralEdges && sysCfg.neutralEdges.pairs) || []).map((e) => key(e.pair[0], e.pair[1])),
  );

  const goldPairs = new Map();
  for (const e of gold.doc.edges) {
    const k = key(e.from, e.to);
    if (neutralPairs.has(k)) continue;
    if (!goldPairs.has(k)) goldPairs.set(k, { from: e.from, to: e.to, label: e.label });
  }

  const prodIndexById = new Map(prod.map((p) => [p.id, p.index]));
  const resolve = (endpoint) => {
    const i = prodIndexById.get(endpoint);
    return i === undefined ? null : (toGold.get(i) ?? null);
  };

  const prodPairs = new Map(); // key -> {from,to,copies:[{from,to,arrow}]}
  const unresolvable = [];
  for (const e of produced.edges || []) {
    const from = resolve(e.from);
    const to = resolve(e.to);
    if (!from || !to || from === to) {
      unresolvable.push({ from: e.from, to: e.to, label: e.label });
      continue;
    }
    const k = key(from, to);
    if (neutralPairs.has(k)) continue;
    if (!prodPairs.has(k)) prodPairs.set(k, { copies: [] });
    prodPairs.get(k).copies.push({ from, to, arrow: e.arrow ?? 'forward' });
  }

  const hitKeys = [...prodPairs.keys()].filter((k) => goldPairs.has(k));
  const edgePrecision = ratio(hitKeys.length, prodPairs.size);
  const edgeRecall = ratio(hitKeys.length, goldPairs.size);
  const edgePrecisionStrict = ratio(hitKeys.length, prodPairs.size + unresolvable.length);

  // --- direction, its own number ------------------------------------------
  let dirRight = 0;
  const reversed = [];
  let undirected = 0;
  for (const k of hitKeys) {
    const g = goldPairs.get(k);
    const copies = prodPairs.get(k).copies;
    const allRight = copies.every(
      (c) => c.from === g.from && c.to === g.to && c.arrow === 'forward',
    );
    if (copies.some((c) => c.arrow !== 'forward')) undirected += 1;
    if (allRight) dirRight += 1;
    else reversed.push({ gold: `${g.from} -> ${g.to}`, produced: copies.map((c) => `${c.from} -> ${c.to}${c.arrow === 'forward' ? '' : ` (arrow: ${c.arrow})`}`) });
  }

  // --- the planted hidden edge (G12) --------------------------------------
  const he = sysCfg.hiddenEdge;
  const heKey = key(he.from, he.to);
  const hePair = prodPairs.get(heKey);
  // Citation evidence. Schema v1 gives an edge nowhere to carry a citation, so
  // this searches every place the DOCUMENT can carry text. It is weaker than
  // "this edge is cited" and is reported, never gated on; see the header.
  const citationRe = he.citation ? new RegExp(he.citation, 'i') : null;
  const documentText = [
    String(produced.title ?? ''),
    ...prodNodes.flatMap((n) => [
      String(n.note ?? ''),
      ...Object.values(n.meta ?? {}).map((v) => String(v)),
    ]),
    ...(produced.edges || []).map((e) => String(e.label ?? '')),
  ];
  const citationHit = citationRe ? documentText.find((t) => citationRe.test(t)) : undefined;

  // Per-EDGE provenance, which is what both answer keys actually asked for and
  // what nothing could measure before P5-01: of the produced edges that ARE the
  // hidden pair, do any carry a binding naming the accepted source file — and
  // did that binding resolve? A ref that matches the pattern but points at
  // nothing is not evidence, so `resolved` is reported beside `cited` and is
  // the number to read. Left as evidence, not a gate: `found` is unchanged, so
  // the G12 series stays comparable with every run before this one.
  const hiddenEdgeBindings = [];
  for (const e of produced.edges || []) {
    const from = resolve(e.from);
    const to = resolve(e.to);
    if (!from || !to || key(from, to) !== heKey) continue;
    for (const b of e.bindings ?? []) hiddenEdgeBindings.push({ edgeId: String(e.id ?? ''), b });
  }
  const heCited = hiddenEdgeBindings.filter(
    ({ b }) => citationRe && citationRe.test(String(b.ref ?? '')),
  );
  const heCitedResolved = heCited.filter(
    ({ edgeId, b }) => bindingStatusOf(bindings, 'edge', edgeId, b) === 'ok',
  );

  const hiddenEdge = {
    expected: `${he.from} -> ${he.to}`,
    what: he.label,
    found: Boolean(hePair),
    directionCorrect: Boolean(
      hePair && hePair.copies.every((c) => c.from === he.from && c.to === he.to && c.arrow === 'forward'),
    ),
    citation: {
      _what:
        'evidence that the accepted source file was read (rules 9 and 15). `citedInBinding` is the per-EDGE measurement P5-01 made possible; `citedInDocument` is the older, weaker document-level signal, kept so the series stays comparable with every run before bindings existed.',
      accepted: he.citation ?? null,
      citedInDocument: Boolean(citationHit),
      where: citationHit ?? null,
      // A binding on the hidden edge itself, naming the accepted source file.
      citedInBinding: heCited.length > 0,
      // ...and that binding RESOLVED. A ref matching the pattern but pointing
      // at nothing is not evidence of reading anything; this is the number to
      // read. Null when bindings were not scored (no --bindings-root).
      citedInResolvedBinding: bindings.scored ? heCitedResolved.length > 0 : null,
      bindings: hiddenEdgeBindings.map(({ edgeId, b }) => ({
        edge: edgeId,
        binding: `${b.source}=${b.ref}${b.line === undefined ? '' : `:${b.line}`}`,
        status: bindingStatusOf(bindings, 'edge', edgeId, b),
      })),
    },
  };

  // --- node types (reported, not one of the four numbers) ------------------
  const accepted = sysCfg.acceptedTypes || {};
  const typeErrors = [];
  for (const c of pairs) {
    const g = gold.nodes[c.g];
    const p = prod[c.p];
    const ok = p.type === g.type || (accepted[g.id] || []).includes(p.type);
    if (!ok) typeErrors.push({ node: g.id, gold: g.type, produced: p.type, as: p.id });
  }

  return {
    system: sys,
    bindings,
    nodes: {
      goldCount: gold.nodes.length,
      producedCount: prod.length,
      matched: pairs.length,
      precision: ratio(pairs.length, nodeDenomProduced),
      recall: ratio(pairs.length, gold.nodes.length),
      missing,
      neutral,
      matches: pairs.map((c) => ({
        gold: c.goldId,
        produced: prod[c.p].id,
        tier: c.tier === 3 ? 'exact' : c.tier === 2 ? 'alias' : 'modifier',
      })),
    },
    edges: {
      goldCount: goldPairs.size,
      producedCount: prodPairs.size,
      matched: hitKeys.length,
      precision: edgePrecision,
      recall: edgeRecall,
      precisionStrict: edgePrecisionStrict,
      missing: [...goldPairs.entries()]
        .filter(([k]) => !prodPairs.has(k))
        .map(([, g]) => `${g.from} -> ${g.to}`),
      unresolvable,
    },
    direction: {
      _what: 'of the edges correctly identified, the fraction pointing the right way (G9)',
      scored: hitKeys.length,
      correct: dirRight,
      accuracy: ratio(dirRight, hitKeys.length),
      nonForwardArrows: undirected,
      reversed,
    },
    invention: {
      _what: 'produced nodes that match no gold node and no documented accepted variant',
      count: inventedNodes.length,
      rate: ratio(inventedNodes.length, nodeDenomProduced || 1),
        plantedAbsenceDrawn: plantedAbsenceDrawn.length > 0 || byType.length > 0,
      plantedAbsence: {
        what: absence.label,
        drawn: plantedAbsenceDrawn.map((n) => n.id),
        byForbiddenType: byType,
        _whyByType:
          'nodes whose TYPE is on plantedAbsence.forbiddenTypes, whether or not their name matched a gold node — the name-independent half of G13',
      },
      nodes: inventedNodes,
    },
    hiddenEdge,
    types: {
      checked: pairs.length,
      accuracy: ratio(pairs.length - typeErrors.length, pairs.length),
      errors: typeErrors,
    },
    groups: {
      _what: 'reported, never scored: gold-citations.md documents defensible groupings on both systems',
      goldCount: gold.doc.groups.length,
      producedCount: (produced.groups || []).length,
      produced: (produced.groups || []).map((g) => g.id),
    },
  };
}

/**
 * Read both documents from disk and score them.
 *
 * `opts.bindingsRoot` is the tree the agent read — eval.sh passes the staged
 * copy of the reference system, never fixtures/ref-<s>/ (which the agent has
 * never seen, and which holds the answer key).
 */
export function scoreFiles(producedPath, goldPath, sys, configPath = CONFIG_PATH, opts = {}) {
  const cfg = loadConfig(configPath);
  const gold = loadGold(goldPath, sys, cfg);
  const produced = JSON.parse(fs.readFileSync(producedPath, 'utf8'));
  return score(produced, gold, sys, cfg, opts);
}

// ---------------------------------------------------------------------------
// CLI:  node scripts/eval/score.mjs --doc <produced.json> --gold <gold.json> --system a
// ---------------------------------------------------------------------------

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['doc', 'gold', 'system']) {
    if (!args[k]) {
      process.stderr.write(
        'usage: node scripts/eval/score.mjs --doc <produced.json> --gold <gold.json> --system a|b\n' +
          '                                 [--run <n>] [--bindings-root <staged system dir>]\n' +
          '                                 [--bindings-alt-root <the workspace above it>]\n',
      );
      process.exit(2);
    }
  }
  const bindingsRoot = args['bindings-root'];
  const bindingsAltRoot = args['bindings-alt-root'];
  if (bindingsRoot && !fs.existsSync(bindingsRoot)) {
    // A root that is not there would resolve every citation as missing and
    // report precision 0.0 for a document that may be perfect. That is the one
    // direction of error this feature must never make, so it is fatal.
    process.stderr.write(`score.mjs: --bindings-root does not exist: ${bindingsRoot}\n`);
    process.exit(2);
  }
  const out = scoreFiles(args.doc, args.gold, args.system, CONFIG_PATH, {
    ...(bindingsRoot ? { bindingsRoot } : {}),
    ...(bindingsAltRoot ? { bindingsAltRoot } : {}),
  });
  if (args.run) out.run = Number(args.run);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
