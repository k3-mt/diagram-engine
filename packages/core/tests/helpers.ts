// Shared test helpers: fixture loading and small document builders.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GEdge, GGroup, GNode, GraphDoc } from '../src/index.js';

/** Absolute path to the repo-root tests/fixtures directory. */
export const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures',
);

/** Raw text of a fixture file. */
export function fixtureRaw(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

/** Parse a fixture as untyped JSON (no validation). */
export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureRaw(name));
}

/** A minimal valid empty document. */
export function doc(overrides: Partial<GraphDoc> = {}): GraphDoc {
  return {
    schemaVersion: 1,
    title: 'Test doc',
    direction: 'DOWN',
    nodes: [],
    groups: [],
    edges: [],
    collapsed: [],
    ...overrides,
  };
}

export function node(id: string, overrides: Partial<GNode> = {}): GNode {
  return { id, label: id, type: 'service', parent: null, ...overrides };
}

export function group(id: string, overrides: Partial<GGroup> = {}): GGroup {
  return { id, label: id, kind: 'generic', parent: null, ...overrides };
}

export function edge(
  id: string,
  from: string,
  to: string,
  overrides: Partial<GEdge> = {},
): GEdge {
  return { id, from, to, ...overrides };
}
