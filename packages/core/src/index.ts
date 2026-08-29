// @diagram-engine/core — public entry point.
// M1 Step 2: the schema module (the contract for everything).
// Later milestones add: document/, view/, store/, format/.

export * from './schema/graph.js';
export * from './schema/patch.js';
export * from './schema/jsonSchema.js';

// M1 Step 3: document operations and formatting.
export * from './document/ids.js';
export * from './document/validate.js';
export * from './document/apply.js';
export * from './document/history.js';
export * from './format/summary.js';
export * from './format/table.js';

// M1 Step 4: the .diagram/ store (paths, reads, atomic writes, lock, history).
export * from './store/index.js';

export const CORE_PACKAGE = '@diagram-engine/core';
