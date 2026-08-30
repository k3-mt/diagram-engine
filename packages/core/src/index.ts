// @diagram-engine/core — public entry point.
// M1 Step 2: the schema module (the contract for everything).
// Later milestones add: document/, view/, store/, format/.

export * from './schema/graph.js';
export * from './schema/patch.js';
export * from './schema/jsonSchema.js';
export * from './schema/issues.js';

// M1 Step 3: document operations and formatting.
export * from './document/ids.js';
export * from './document/validate.js';
export * from './document/apply.js';
export * from './document/history.js';
// P5-01: the pure half of provenance (spec §3.8) — parsing, classifying and
// normalising a binding ref, and walking the document's bindings. No node:fs,
// so `diagram check --bindings` is the IO half and nothing else.
export * from './bindings/index.js';
export * from './format/summary.js';
export * from './format/table.js';

// M1 Step 4: the .diagram/ store (paths, reads, atomic writes, lock, history).
export * from './store/index.js';

// M6 Step 15: the agent-facing rules text, and the view presets that decide
// which groups a preset collapses. Both are consumed by the CLI and the MCP
// server, so they belong on the public surface rather than behind a deep path.
export * from './rules/load.js';
export * from './view/presets.js';

// M7 Step 16: the collapse-and-merge pass that turns a document plus a
// collapsed list into the document that is actually drawn. On the barrel
// because the CLI, the MCP export tool and the viewer all need it — but note
// the viewer and the CLI's compiled tree import it by PATH, not from here:
// this barrel also re-exports store/ (node:fs), which must not reach the
// browser bundle.
export * from './view/derive.js';

// Part 15 / Part 18: the read-only analysis pass — the runtime projection, the
// six structural signals, the assembled Analysis, and the blast radius and
// experiment backlog built on top of it. Nothing under analysis/ touches
// node:fs, so the viewer imports that directory BY PATH
// (`core/src/analysis/index.js`) exactly as it does view/derive.js — this
// barrel re-exports store/ and must not reach the browser bundle.
export * from './analysis/index.js';

export const CORE_PACKAGE = '@diagram-engine/core';
