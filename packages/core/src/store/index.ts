// store/ — .diagram/ persistence: paths, validated reads, atomic writes,
// locking, and on-disk history (spec §2.5, M1 Step 4).
//
// Exported from here rather than src/index.ts to avoid clashing with
// concurrent edits to the package entry point; wire
// `export * from './store/index.js';` into src/index.ts when convenient.

export * from './paths.js';
export * from './read.js';
export * from './write.js';
