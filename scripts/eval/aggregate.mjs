// scripts/eval/aggregate.mjs — fold N per-run scores into eval-<system>.json
// (BUILD.md P3-05).
//
// A mean alone hides a bimodal result, and a bimodal result is exactly what a
// rules problem looks like: three runs at 1.00 and three at 0.55 is a rules.md
// sentence that fires half the time, and it averages to a comfortable 0.78
// that nobody investigates. So every metric carries mean, min, max and the
// spread, `runs[]` keeps the whole per-run detail, and `flags` names the
// things a human should look at before touching rules.md.
//
// usage: node scripts/eval/aggregate.mjs --system a --out eval-a.json <run1.json> ...

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Metric paths that get mean/min/max.
 *
 * A `null` means the denominator was zero — an empty document has no node
 * precision, and 0/0 is not 0. Those runs cannot enter a mean. But DROPPING
 * them silently is the one bias this rig must not have: a 20-run G9 set in
 * which ten runs produced nothing would report direction.accuracy 1.00 with
 * spread 0 and no flag, and the ten dead runs would be exactly the hard ones.
 * So every metric carries `n` AND `absent`, and any metric scored in fewer
 * runs than were attempted raises a flag saying the mean describes a subset.
 */
const METRICS = [
  ['node.precision', (r) => r.nodes.precision],
  ['node.recall', (r) => r.nodes.recall],
  ['edge.precision', (r) => r.edges.precision],
  ['edge.recall', (r) => r.edges.recall],
  ['direction.accuracy', (r) => r.direction.accuracy],
  ['invention.count', (r) => r.invention.count],
  ['type.accuracy', (r) => r.types.accuracy],
  // Provenance (P5-02). Two metrics, never one: precision is the HONESTY
  // number (of the citations produced, how many resolve) and coverage the
  // EFFORT number (how much of the diagram is cited at all). An agent that
  // cites one node perfectly must not score like one that cites everything
  // perfectly, and folding them would let it. `?.` throughout: a run scored
  // before bindings existed has no `bindings` key and must come through as
  // absent, not as zero — a zero would read as "it cited nothing", which is a
  // claim about the agent, not about the harness that could not ask.
  ['binding.precision', (r) => r.bindings?.precision ?? null],
  // The same numerator as precision over EVERY produced citation, so an
  // unchecked one costs what an unresolved one does. Precision is the gate;
  // this is what stops the gate being passed by citing in forms nothing can
  // check, and what makes a regression that moves citations out of `resolved`
  // and into `unchecked` show up as a fall rather than as no change at all.
  ['binding.verified', (r) => r.bindings?.verifiedShare ?? null],
  ['binding.coverage', (r) => r.bindings?.coverage ?? null],
];

const round = (n) => (n === null ? null : Number(n.toFixed(4)));

function summarise(values) {
  const xs = values.filter((v) => v !== null && v !== undefined);
  const absent = values.length - xs.length;
  if (!xs.length) return { n: 0, absent, mean: null, min: null, max: null, spread: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return { n: xs.length, absent, mean: round(mean), min: round(min), max: round(max), spread: round(max - min) };
}

/**
 * `attempted` is how many runs eval.sh LAUNCHED, which is not how many it
 * scored: a run that dies in staging, in `diagram init` or in the scorer leaves
 * no score.json behind and would otherwise vanish from the record entirely,
 * making a 20-run set with 14 crashes byte-identical to a deliberate 6-run one.
 */
export function aggregate(runs, system, attempted = runs.length, provenance = null) {
  const summary = {};
  for (const [name, get] of METRICS) summary[name] = summarise(runs.map(get));

  const hiddenFound = runs.filter((r) => r.hiddenEdge.found).length;
  const hiddenRight = runs.filter((r) => r.hiddenEdge.found && r.hiddenEdge.directionCorrect).length;
  const absenceDrawn = runs.filter((r) => r.invention.plantedAbsenceDrawn).length;
  const hiddenCited = runs.filter((r) => r.hiddenEdge.found && r.hiddenEdge.citation?.citedInDocument).length;
  const hiddenBound = runs.filter(
    (r) => r.hiddenEdge.found && r.hiddenEdge.citation?.citedInResolvedBinding === true,
  ).length;
  const bindingRuns = runs.filter((r) => r.bindings?.scored === true);

  const flags = [];
  const failed = Math.max(0, attempted - runs.length);
  if (failed > 0) {
    flags.push(
      `${failed}/${attempted} run(s) produced no score at all and are in NO mean below — ` +
        `the harness failed before scoring, and harness failures correlate with the hard runs. ` +
        `Read the logs before reading these numbers.`,
    );
  }
  // 0.25 is the point at which a mean stops describing any run in the set.
  for (const [name, s] of Object.entries(summary)) {
    if (s.spread !== null && s.spread >= 0.25) {
      flags.push(`${name}: spread ${s.spread} across ${s.n} runs (min ${s.min}, max ${s.max}) — the mean describes no run; read runs[] before changing rules.md`);
    }
    if (s.absent > 0) {
      // Two different causes, and telling them apart matters: a node metric is
      // absent because the document was empty (a real, bad result), a binding
      // metric because nobody gave the scorer a root to resolve against (a
      // harness gap). Sending a reader to look at the agent for the second is
      // how an afternoon gets wasted.
      // A binding metric is absent for TWO reasons, and they point in opposite
      // directions: no root reached the scorer (a harness gap), or a root did
      // and the run produced nothing to resolve — ratio(0,0) is null (an agent
      // result). Blaming the harness for the second is the very inversion this
      // comment warns about, so the cause is read off the runs themselves.
      const scoredWithRoot =
        name.startsWith('binding.') && runs.some((r) => r.bindings?.scored === true);
      const why = !name.startsWith('binding.')
        ? 'had no denominator (an empty or wholly-invented document)'
        : scoredWithRoot
          ? 'were scored against a root but produced no resolvable citation, so there was ' +
            'nothing to compute over (see binding.coverage)'
          : 'were scored without a --bindings-root, so their provenance was never resolved';
      flags.push(
        `${name}: scored in only ${s.n}/${attempted} run(s) — ${s.absent} of them ${why} ` +
          `and are excluded, so the mean describes a subset`,
      );
    }
  }
  const dir = summary['direction.accuracy'];
  if (dir.mean !== null && dir.mean < 0.95) {
    flags.push(`direction.accuracy mean ${dir.mean} is below the 0.95 bar (acceptance G9)`);
  }
  if (absenceDrawn > 0) {
    flags.push(`planted absence drawn in ${absenceDrawn}/${runs.length} runs (acceptance G13): ${runs[0].invention.plantedAbsence.what}`);
  }
  if (hiddenFound < runs.length) {
    flags.push(`planted hidden edge missed in ${runs.length - hiddenFound}/${runs.length} runs (acceptance G12): ${runs[0]?.hiddenEdge.expected}`);
  }
  // Found but backwards is the exact M8 failure this rig was built around, and
  // on system A one reversed edge in twelve is a 0.083 dip that clears the 0.95
  // bar. It needs its own flag, not a fraction of another number.
  if (hiddenRight < hiddenFound) {
    flags.push(
      `planted hidden edge drawn BACKWARDS in ${hiddenFound - hiddenRight}/${hiddenFound} of the runs that found it (G12 + G9): ${runs[0]?.hiddenEdge.expected}`,
    );
  }
  // Rule 9 evidence. Both answer keys say a hidden edge nobody can point at a
  // source file for is a lucky guess; this is the only signal available until
  // GBinding lands, so it is a flag rather than a gate.
  // Only when the STRONGER per-edge signal has also failed. Once an agent cites
  // the hidden edge with a binding that resolves, rule 9 is satisfied and
  // repeating a weaker complaint about the document's prose is noise — and a
  // flag that fires on a clean set is a flag people learn to skip.
  if (hiddenFound > 0 && hiddenCited < hiddenFound && hiddenBound < hiddenFound) {
    flags.push(
      `planted hidden edge drawn in ${hiddenFound}/${runs.length} runs but named in the document TEXT ` +
        `(a note, a meta value, a label) in only ${hiddenCited} — the weak, pre-bindings signal; ` +
        `the per-edge one is citedByResolvingBindingRuns`,
    );
  }
  // Provenance flags (acceptance G10, G11).
  if (bindingRuns.length === 0) {
    flags.push(
      'bindings were NOT resolved in any run — no --bindings-root reached the scorer, so ' +
        'G10/G11 say nothing about this set. eval.sh passes the staged system automatically; ' +
        'with --score-only, pass --bindings-root <dir>.',
    );
  } else {
    const bp = summary['binding.precision'];
    if (bp.mean !== null && bp.mean < 1) {
      flags.push(
        `binding.precision mean ${bp.mean} (min ${bp.min}) is below the 1.0 bar (acceptance G10): ` +
          'a citation that does not resolve is worse than no citation, because it reads as ' +
          'evidence. Read detail[].bindings.failures — each line is the exact string in the document.',
      );
    }
    const bc = summary['binding.coverage'];
    if (bc.mean !== null && bc.mean < 1) {
      flags.push(
        `binding.coverage mean ${bc.mean} — ${Math.round((1 - bc.mean) * 100)}% of produced nodes ` +
          'and edges carry no citation at all (acceptance G11 wants every one of them cited)',
      );
    }
    // Precision is computed over the citations that COULD be resolved. A
    // citation the checker could not answer either way — a file too large to
    // read, a compose file written in flow style — is in neither side of it,
    // which is right for an invention detector, but it also means a set of
    // such citations is unfalsifiable while reading as fully sourced.
    //
    // Identifier refs are searched for now, so this residue should be near
    // zero on a real repository — §3.8 calls it "a residue, not a category the
    // tool is comfortable with". The threshold is therefore 5%, not the half
    // it was when a whole class of refs was uncheckable: at the old bar this
    // could go from a quarter of every corpus to a quarter still, silently.
    const producedTotal = bindingRuns.reduce((n, r) => n + (r.bindings.produced ?? 0), 0);
    const uncheckedTotal = bindingRuns.reduce((n, r) => n + (r.bindings.unchecked ?? 0), 0);
    if (producedTotal > 0 && uncheckedTotal / producedTotal > 0.05) {
      flags.push(
        `${uncheckedTotal}/${producedTotal} citations across the set could not be checked either ` +
          'way — precision is computed over the rest, so that share of this set is ' +
          'unfalsifiable. §3.8 wants the residue near zero; read detail[].bindings.results for ' +
          'the unchecked rows and why each one landed there.',
      );
    }
    // The exploit precision's denominator leaves open, named out loud: a set
    // can score the 1.0 bar while most of its citations were never verified,
    // because precision excludes them and coverage only counts that a citation
    // was WRITTEN. This is the flag that makes the difference between the two
    // numbers say it, rather than leaving it to whoever reads both columns.
    const bv = summary['binding.verified'];
    if (bp.mean !== null && bv.mean !== null && bp.mean >= 1 && bv.mean < 1) {
      flags.push(
        `binding.precision is ${bp.mean} but binding.verified is ${bv.mean} — the bar is met ` +
          'only because unchecked citations are outside precision\'s denominator. ' +
          `${uncheckedTotal}/${producedTotal} citations were never verified against the tree; ` +
          'an unfalsifiable citation is not evidence of having read anything (rule 15).',
      );
    }
    if (hiddenFound > hiddenBound) {
      flags.push(
        `planted hidden edge cited to its source file by a RESOLVING binding in only ` +
          `${hiddenBound}/${hiddenFound} of the runs that found it (rules 9 and 15) — ` +
          'an edge nobody can point at a source file for is a lucky guess',
      );
    }
  }
  // types.accuracy raises no gate anywhere, and on system B it is the residue
  // left by a mistyped node, so a dip must at least be visible.
  const ty = summary['type.accuracy'];
  if (ty.mean !== null && ty.mean < 1) {
    flags.push(`type.accuracy mean ${ty.mean} — one or more nodes carry the wrong element type; read detail[].types.errors`);
  }

  return {
    _what: `eval-${system}.json — M8 measurement rig output (BUILD.md P3-05). Four scored numbers plus the two planted checks.`,
    system,
    generated: new Date().toISOString().slice(0, 10),
    provenance,
    runsRequested: attempted,
    runsScored: runs.length,
    runsFailed: failed,
    runs: runs.length,
    summary,
    planted: {
      hiddenEdge: {
        expected: runs[0]?.hiddenEdge.expected ?? null,
        what: runs[0]?.hiddenEdge.what ?? null,
        foundRuns: hiddenFound,
        foundAndCorrectDirectionRuns: hiddenRight,
        citedToSourceRuns: hiddenCited,
        citedByResolvingBindingRuns: hiddenBound,
        rate: runs.length ? round(hiddenFound / runs.length) : null,
      },
      absence: {
        what: runs[0]?.invention.plantedAbsence.what ?? null,
        drawnRuns: absenceDrawn,
        rate: runs.length ? round(absenceDrawn / runs.length) : null,
      },
    },
    bindings: {
      _what:
        'provenance across the set (G10/G11). precision is the honesty number (over the ' +
        'citations that could be checked), verified is the same numerator over ALL of them, ' +
        'and coverage is the effort number; the means are in summary. The three totals below ' +
        'are disjoint — resolved + unchecked + failures = produced — so a regression that ' +
        'moves citations from resolved into unchecked is visible rather than absorbed. ' +
        'Resolved by the same code as `diagram check --bindings`.',
      scoredRuns: bindingRuns.length,
      producedTotal: bindingRuns.reduce((n, r) => n + (r.bindings.produced ?? 0), 0),
      resolvedTotal: bindingRuns.reduce((n, r) => n + (r.bindings.resolved ?? 0), 0),
      uncheckedTotal: bindingRuns.reduce((n, r) => n + (r.bindings.unchecked ?? 0), 0),
      failuresTotal: bindingRuns.reduce((n, r) => n + (r.bindings.failures?.length ?? 0), 0),
    },
    flags,
    detail: runs,
  };
}

function main(argv) {
  const files = [];
  let system = null;
  let out = null;
  let attempted = null;
  // What was measured, so two operators can tell whether they measured the same
  // thing: the agent command, whether it was confined, and a fingerprint of the
  // two inputs that are not the reference system — the prompt and rules.md.
  let provenance = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--system') system = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--attempted') attempted = Number(argv[++i]);
    else if (argv[i] === '--provenance') provenance = JSON.parse(argv[++i]);
    else files.push(argv[i]);
  }
  if (!system || !out || !files.length) {
    process.stderr.write('usage: node scripts/eval/aggregate.mjs --system a|b --out <path> [--attempted <n>] <run.json>...\n');
    process.exit(2);
  }
  // Sort by run number so the output is identical however the shell globbed.
  const runs = files
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .sort((a, b) => (a.run ?? 0) - (b.run ?? 0));
  const doc = aggregate(runs, system, attempted && attempted > 0 ? attempted : runs.length, provenance);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(doc.summary, null, 2)}\n`);
  for (const f of doc.flags) process.stdout.write(`  flag: ${f}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
