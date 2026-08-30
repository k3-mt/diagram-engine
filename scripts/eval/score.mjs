// scripts/eval/score.mjs — the scorer for the M8 eval harness (BUILD.md P3-05,
// spec Part 10 M8, acceptance G9, G12 and G13).
//
// NOT G10/G11. G11 is "every node carries a binding whose chip opens the right
// file", and there is no binding in the schema yet: GNode has no such field
// (packages/core/src/schema/graph.ts), neither gold file carries one, and
// BUILD.md P5-01 is where GBinding arrives. P5-02 adds binding precision to
// this harness. Until then nothing here measures provenance, and the header
// says so rather than implying coverage.
//
// Input: one produced document (whatever `diagram export json` wrote) and one
// gold document (fixtures/ref-<s>/gold.json). Output: four numbers.
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
// guess. That cannot be measured per-edge in schema v1: GEdge carries
// id/from/to/label/style/arrow/cardinality and nothing else — no note, no meta,
// no binding — so an agent has nowhere to hang an edge citation. So `found`
// stays exactly what it was (the pair is drawn, the number stays comparable)
// and a SECOND, weaker number is reported beside it: `citedInDocument`, true
// when the accepted source path appears anywhere the document can carry text —
// node notes, node meta values, edge labels, the title. It is document-level,
// not edge-level, and it is scored as evidence rather than as the gate. The
// real per-edge measurement arrives with GBinding (BUILD.md P5-01/P5-02).
//
// Direction is scored only over pairs that are in BOTH documents: of the edges
// correctly identified, the fraction pointing the right way. A pair drawn more
// than once (an agent splitting "proxies" and "introspects" into two edges) is
// direction-correct only if EVERY copy points the gold way; `arrow: "both"` or
// `"none"` is not the gold direction and is also reported separately.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, 'config.json');

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
 */
export function score(produced, gold, sys, cfg) {
  const sysCfg = cfg[sys];
  if (!sysCfg) throw new Error(`no scoring config for system "${sys}"`);

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
  const hiddenEdge = {
    expected: `${he.from} -> ${he.to}`,
    what: he.label,
    found: Boolean(hePair),
    directionCorrect: Boolean(
      hePair && hePair.copies.every((c) => c.from === he.from && c.to === he.to && c.arrow === 'forward'),
    ),
    citation: {
      _what:
        'document-level evidence that the accepted source file was read (rule 9). GEdge has no note/meta/binding in schema v1, so this is not per-edge; per-edge provenance arrives with GBinding (BUILD.md P5-01/P5-02).',
      accepted: he.citation ?? null,
      citedInDocument: Boolean(citationHit),
      where: citationHit ?? null,
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

/** Read both documents from disk and score them. */
export function scoreFiles(producedPath, goldPath, sys, configPath = CONFIG_PATH) {
  const cfg = loadConfig(configPath);
  const gold = loadGold(goldPath, sys, cfg);
  const produced = JSON.parse(fs.readFileSync(producedPath, 'utf8'));
  return score(produced, gold, sys, cfg);
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
        'usage: node scripts/eval/score.mjs --doc <produced.json> --gold <gold.json> --system a|b [--run <n>]\n',
      );
      process.exit(2);
    }
  }
  const out = scoreFiles(args.doc, args.gold, args.system);
  if (args.run) out.run = Number(args.run);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
