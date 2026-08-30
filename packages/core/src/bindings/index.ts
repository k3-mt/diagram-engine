// bindings/ — provenance (spec §3.8). The pure half only: parsing,
// classifying and normalising a ref, and walking the document's bindings.
// No node:fs here, so `diagram check --bindings` is the IO and nothing else,
// and the viewer can import this directory by path.

export * from './ref.js';
export * from './identifier.js';
