// schema/jsonSchema.ts — plain JSON Schema for the diagram_patch tool
// input (spec §2.4), generated from the same zod source as patch.ts so
// there is a single source of truth. Uses zod's native JSON Schema
// conversion (z.toJSONSchema, available in the installed zod's v4 API).
// No extra dependencies.

import { z } from 'zod/v4';
import { GraphDocSchema } from './graph.js';
import { GraphPatchSchema } from './patch.js';

/** A plain JSON Schema object, safe to embed in an MCP tool definition. */
export type PlainJsonSchema = Record<string, unknown>;

/**
 * JSON Schema for the GraphPatch input ({ ops, summary }) — the input
 * schema of the diagram_patch MCP tool.
 */
export function graphPatchJsonSchema(): PlainJsonSchema {
  return z.toJSONSchema(GraphPatchSchema) as PlainJsonSchema;
}

/**
 * JSON Schema for the full GraphDoc, from the same zod source. Useful
 * for file-protocol agents (§4.3) and for validating graph.json.
 */
export function graphDocJsonSchema(): PlainJsonSchema {
  return z.toJSONSchema(GraphDocSchema) as PlainJsonSchema;
}
