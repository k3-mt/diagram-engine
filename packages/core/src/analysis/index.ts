// analysis/index.ts — the analysis surface (spec Part 15, Part 18 §18.3–18.7).
//
// Everything here is a PURE FUNCTION OF A DOCUMENT. Nothing reads the file
// system, nothing mutates, nothing executes (A1, C1), and nothing accepts a
// derived view (A2). Structured data only — the CLI, the MCP tools and the
// viewer format it three different ways from these same numbers.
//
// This directory has no node:fs import, so it is safe for the browser bundle
// to import by path, the way the viewer already imports view/derive.js.

export * from './graph.js';
export * from './signals.js';
export * from './analyse.js';
export * from './blast.js';
