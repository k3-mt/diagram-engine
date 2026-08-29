// mcp/tools.ts — the seven MCP tool definitions (spec §4.1, M6 Step 15).
//
// This is the primary agent surface: an agent that speaks MCP (Model Context
// Protocol — the open standard for handing tools to a coding agent over
// stdio) drives the whole engine through these seven tools and nothing else.
//
// Three things about this file carry more weight than the code does:
//
//   1. THE DESCRIPTION IS THE PROMPT. There is no system prompt in this
//      architecture, so diagram_patch's description carries the rules
//      (spec §4.1, §4.4). It is the compact form of packages/core/rules.md,
//      generated from that file rather than restated here, so the rules the
//      agent reads cannot drift from the rules the docs promise.
//
//   2. RESULTS ARE TERSE TEXT, NEVER JSON. The agent reads every result as
//      context on the next turn, so verbosity costs tokens and attention.
//      The wording comes from commands/context.ts, shared with the CLI, so
//      `diagram patch` and diagram_patch cannot disagree about what happened.
//
//   3. A REJECTED PATCH IS A NORMAL RESULT. Rule 11 tells the agent to read
//      the errors and fix the patch; a protocol-level error is not something
//      it can read that way, and several clients hide it or retry blindly.
//      So a rejection comes back as ordinary result text and only a genuine
//      internal fault (a thrown exception) is flagged as an error.
//
// The definitions are transport-free on purpose: a handler is a plain
// function from (args, context) to text, so the tests call it directly and
// server.ts is left with nothing but wiring.
//
// Runtime import of core by relative path (not '@diagram-engine/core'), as
// everywhere else in this package: core is consumed as TS source and the CLI
// build compiles core's src alongside its own, so the specifier resolves both
// from src/ under vitest and from dist/ after a build.

import * as fs from 'node:fs';
import {
  GraphPatchSchema,
  compactRules,
  formatIssues,
  graphPatchJsonSchema,
  type PlainJsonSchema,
} from '../../../core/src/index.js';
import {
  applyAndCommit,
  failed,
  loadDoc,
  ok,
  renderCounts,
  renderPatchResult,
  renderRejection,
  type CommandResult,
  type DiagramContext,
} from '../commands/context.js';
import { runGet } from '../commands/get.js';
import { runUndo } from '../commands/undo.js';
import { runRedo } from '../commands/redo.js';
import {
  DEFAULT_JSON_OUT,
  runExport,
  type ExportOptions,
} from '../commands/export.js';
import { runReset } from '../commands/reset.js';
import {
  applyCollapsed,
  missingDiagram,
  renderViewResult,
  runView,
} from '../commands/view.js';

/**
 * What a tool hands back: the text the agent reads, and whether it worked.
 *
 * It is deliberately the SAME type the CLI command bodies return
 * (commands/context.ts), because most tools here are one line: call the
 * command body, hand back what it said. `ok` is not the MCP `isError` flag —
 * a rejection is a normal result the agent self-corrects from (rule 11), and
 * server.ts sets isError only for an internal fault.
 */
export type ToolResult = CommandResult;

/** A tool as both an advertisement (list_tools) and an implementation. */
export interface ToolDefinition {
  name: string;
  /** For diagram_patch this is the rules text — see the header note. */
  description: string;
  inputSchema: PlainJsonSchema;
  /**
   * Check `args` against inputSchema before dispatch: reject a key the schema
   * does not declare. True for every hand-written schema here. False ONLY for diagram_patch, which
   * validates its whole argument object against the same zod source that
   * validates the document — a shallower pre-check in front of that would
   * replace a precise per-op message with a generic one.
   */
  strictArgs: boolean;
  /**
   * Wrong-name -> right-name hints for the refusal. The CLI and the MCP tool
   * are twins but not synonyms, and where they differ an agent carrying the
   * flag name over must be told the property name rather than have its key
   * silently dropped.
   */
  argHints?: Record<string, string>;
  /** MCP hints; clients use them to decide what to confirm with the user. */
  annotations: {
    title: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  /**
   * Run the tool. Never throws for a user-level problem — returns ok:false.
   *
   * The return type admits a promise because ONE tool genuinely needs it:
   * diagram_export writing an SVG runs a layout pass and ELK is
   * asynchronous. The other six return their result outright. There is no
   * second, synchronous handler and no second dispatcher — a tool surface
   * with two entry points is a tool surface where one of them quietly does
   * less, which is exactly what `callTool` is here to prevent.
   */
  handler(
    args: Record<string, unknown>,
    ctx: DiagramContext,
  ): ToolResult | Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Small shared shapes
// ---------------------------------------------------------------------------

/** The input schema of a no-argument tool. */
const NO_INPUT: PlainJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/**
 * A refusal about the CALL rather than about the document: a bad argument
 * type, a missing required field, a tool that does not exist. "no changes
 * applied" is a promise about a write, so it is not claimed here.
 */
function refuse(headline: string, detail: string[]): ToolResult {
  return failed([`rejected — ${headline}`, ...detail.map((d) => `  ${d}`)].join('\n'));
}

/** The options every tool passes down to a command body. */
function opts(ctx: DiagramContext): { dir: string } {
  return { dir: ctx.dir };
}

// ---------------------------------------------------------------------------
// diagram_get
// ---------------------------------------------------------------------------

const GET_SCHEMA: PlainJsonSchema = {
  type: 'object',
  properties: {
    view: {
      type: 'boolean',
      description:
        'false (default) lists the stored document — what you edit. true lists ' +
        'the DRAWN view instead: groups collapsed by diagram_view appear as one ' +
        'box with a component count, and the edges into them are merged with a ' +
        'count. Use it to check what the reader actually sees.',
    },
  },
  additionalProperties: false,
};

const diagramGet: ToolDefinition = {
  name: 'diagram_get',
  strictArgs: true,
  description:
    'Read the current diagram as a compact text table (title, groups, nodes, ' +
    'edges, and entity fields when present). Call this before patching if you ' +
    'are not certain what already exists — reusing an existing id is the ' +
    'difference between editing the diagram and duplicating it. When a view is ' +
    'set the result ends with a "view:" line saying what is collapsed; pass ' +
    '{"view": true} to list the drawn view rather than the stored document.',
  inputSchema: GET_SCHEMA,
  annotations: { title: 'Read the diagram', readOnlyHint: true },
  // Literally `diagram get`: same table, same empty-diagram note, same view
  // line, same read failure. The CLI and the tool cannot show the agent
  // different pictures.
  handler: (args, ctx) =>
    runGet({ ...opts(ctx), ...(args['view'] === true ? { view: true } : {}) }),
};

// ---------------------------------------------------------------------------
// diagram_patch — the one that carries the rules
// ---------------------------------------------------------------------------

/**
 * The lead paragraph in front of the compact rules. It says what the tool is
 * and what the two possible results look like, because an agent that knows a
 * rejection is readable and non-destructive will read it and retry, and one
 * that does not will re-read the whole document first.
 */
const PATCH_LEAD = [
  'Apply a patch to the diagram document: a list of ops plus a one-line summary.',
  'Ops: addNode, updateNode, removeNode, addGroup, updateGroup, removeGroup,',
  'addEdge, updateEdge, removeEdge, setTitle, setDirection.',
  '',
  'Applied atomically: on any error NOTHING is applied and the result lists the',
  'errors, one per op, for you to fix and resend. That result is not a failure',
  'you need to work around — read it and send a corrected patch.',
  '',
].join('\n');

function patchDescription(): string {
  return `${PATCH_LEAD}${compactRules()}`;
}

const diagramPatch: ToolDefinition = {
  name: 'diagram_patch',
  // See ToolDefinition.strictArgs: the zod parse below is the real check.
  strictArgs: false,
  get description() {
    // A getter, not a constant: compactRules() derives its text from the
    // rules file at first call, and paying for that at module load would
    // charge every `diagram serve` for a string only the MCP server uses.
    return patchDescription();
  },
  inputSchema: graphPatchJsonSchema(),
  annotations: { title: 'Edit the diagram' },
  handler: (args, ctx) => {
    // Validate against the same zod source that validates the document, so a
    // malformed patch is rejected in the same voice as an invalid one.
    const parsed = GraphPatchSchema.safeParse(args);
    if (!parsed.success) {
      return failed(renderRejection(formatIssues(parsed.error.issues)));
    }
    // No pre-seeding here, deliberately. applyAndCommit re-reads graph.json
    // INSIDE the lock, treats a genuinely missing file as the empty document
    // and an unreadable one as an error — so a fresh project just works, a
    // hand-corrupted document is refused rather than silently overwritten
    // (spec §4.3, path C), and this surface says exactly what `diagram patch`
    // says. A seeding write before the lock was both a data-loss bug and a
    // race between two first patches.
    const result = applyAndCommit(ctx, parsed.data);
    const text = renderPatchResult(result);
    return result.ok ? ok(text) : failed(text);
  },
};

// ---------------------------------------------------------------------------
// diagram_undo / diagram_redo
// ---------------------------------------------------------------------------

/** Both directions differ only in which command body they call. */
function historyTool(
  name: 'diagram_undo' | 'diagram_redo',
  description: string,
  step: (o: { dir: string }) => ToolResult,
): ToolDefinition {
  return {
    name,
    description,
    strictArgs: true,
    inputSchema: NO_INPUT,
    annotations: {
      title: name === 'diagram_undo' ? 'Undo the last change' : 'Redo',
    },
    handler: (_args, ctx) => step(opts(ctx)),
  };
}

const diagramUndo = historyTool(
  'diagram_undo',
  'Step the diagram back to the state before the last change. Returns the ' +
    'new state, or "nothing to undo" when there is no earlier state.',
  runUndo,
);

const diagramRedo = historyTool(
  'diagram_redo',
  'Step the diagram forward again after an undo. Returns the new state, or ' +
    '"nothing to redo" when there is nothing ahead.',
  runRedo,
);

// ---------------------------------------------------------------------------
// diagram_view
// ---------------------------------------------------------------------------

const VIEW_SCHEMA: PlainJsonSchema = {
  type: 'object',
  properties: {
    preset: {
      type: 'string',
      enum: ['exec', 'eng', 'focus'],
      description:
        'exec = every top-level boundary collapsed; eng = everything expanded; ' +
        'focus = only the named group and its ancestors expanded.',
    },
    id: {
      type: 'string',
      description: 'The group id to focus on. Required when preset is "focus".',
    },
    collapsed: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Explicit list of group ids to collapse, instead of a preset. ' +
        'An empty array expands everything.',
    },
  },
  additionalProperties: false,
};

const diagramView: ToolDefinition = {
  name: 'diagram_view',
  strictArgs: true,
  description:
    'Set which groups are collapsed — how the diagram reads, not what it ' +
    'means. Pass {"preset":"exec"} for a boardroom-level view, ' +
    '{"preset":"eng"} for everything, {"preset":"focus","id":"<group-id>"} to ' +
    'open one boundary, or {"collapsed":["<group-id>",...]} to say it exactly. ' +
    'Never moves or deletes anything, and diagram_undo puts the old view back.',
  inputSchema: VIEW_SCHEMA,
  annotations: { title: 'Set the view', idempotentHint: true },
  handler: (args, ctx) => {
    // The write, the validation and the wording all live in commands/view.ts,
    // under the same lock and the same history snapshot as `diagram view`.
    // Collapse state is presentation, not meaning, so it is not a patch op —
    // but it IS a document edit, and it is undoable like any other.
    if (!fs.existsSync(ctx.paths.graphFile)) return missingDiagram(ctx);

    const explicit = args['collapsed'];
    if (explicit !== undefined) {
      if (!Array.isArray(explicit) || explicit.some((id) => typeof id !== 'string')) {
        return refuse('collapsed must be an array of group ids', [
          'example: {"collapsed": ["vpc-private"]}',
        ]);
      }
      return renderViewResult(ctx, applyCollapsed(ctx, explicit as string[]));
    }

    const presetName = args['preset'];
    if (typeof presetName !== 'string' || presetName === '') {
      return refuse('diagram_view needs a preset or a collapsed list', [
        'e.g. {"preset": "exec"} or {"collapsed": ["vpc-private"]}',
      ]);
    }
    const id = args['id'];
    return runView(presetName, {
      ...opts(ctx),
      ...(typeof id === 'string' ? { id } : {}),
    });
  },
};

// ---------------------------------------------------------------------------
// diagram_export
// ---------------------------------------------------------------------------

const EXPORT_SCHEMA: PlainJsonSchema = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      enum: ['json', 'svg'],
      description:
        'json = the document exactly as stored (round-trippable). ' +
        'svg = the drawn diagram, laid out and rendered. ' +
        'PNG is not written here: it is a 2x canvas export inside the viewer ' +
        '(run `diagram serve` and press [PNG 2x] in its status bar).',
    },
    path: {
      type: 'string',
      description:
        'Where to write it. Relative paths resolve against the working ' +
        `directory. Defaults to <.diagram>/${DEFAULT_JSON_OUT} for json and ` +
        '<.diagram>/out.svg for svg.',
    },
    full: {
      type: 'boolean',
      description:
        'svg only. false (default) draws what the viewer shows, honouring the ' +
        'collapsed view set by diagram_view. true ignores it and draws every ' +
        'group open. Ignored for json, which is always the stored document.',
    },
  },
  // No `required`: `diagram export` with no format writes json, and §4.2
  // promises the tool and its CLI twin behave the same on the same input.
  additionalProperties: false,
};

/** Argument checking, split out so the schema and the parse stay together. */
function exportArgs(
  args: Record<string, unknown>,
  ctx: DiagramContext,
): ToolResult | ExportOptions {
  // `path` here is `--out` there, `full` here is `--full` there; everything
  // else — the default locations, the png pointer, the "no diagram yet"
  // refusal, the view line — is the CLI's, verbatim.
  const raw = args['path'];
  if (raw !== undefined && typeof raw !== 'string') {
    return refuse('path must be a string', ['e.g. {"path": "arch.svg"}']);
  }
  const format = args['format'];
  if (format !== undefined && typeof format !== 'string') {
    return refuse('format must be a string', ['use "json" or "svg"']);
  }
  const full = args['full'];
  if (full !== undefined && typeof full !== 'boolean') {
    return refuse('full must be a boolean', ['e.g. {"format": "svg", "full": true}']);
  }
  return {
    ...opts(ctx),
    ...(format !== undefined ? { format } : {}),
    ...(raw !== undefined && raw !== '' ? { out: raw } : {}),
    ...(full !== undefined ? { full } : {}),
  };
}

/** A ToolResult, as opposed to the parsed options. */
function isToolResult(v: ToolResult | ExportOptions): v is ToolResult {
  return typeof (v as ToolResult).text === 'string' && typeof (v as ToolResult).code === 'number';
}

const diagramExport: ToolDefinition = {
  name: 'diagram_export',
  strictArgs: true,
  // `--out` on the CLI is `path` here. Without this the mistake is silent:
  // the file lands at the DEFAULT location and the agent's next step — read
  // or commit the file it named — fails with an error naming the wrong cause.
  argHints: { out: 'path', output: 'path', file: 'path', to: 'path' },
  description:
    'Write the diagram to a file and return the path. format "json" writes ' +
    `the document exactly as it is stored, defaulting to <.diagram>/${DEFAULT_JSON_OUT}. ` +
    'format "svg" writes the drawn diagram to <.diagram>/out.svg, showing what ' +
    'the viewer shows — groups collapsed by diagram_view stay collapsed unless ' +
    'you pass {"full": true}. For PNG, run `diagram serve` and press the ' +
    '[PNG 2x] button in the viewer\'s status bar.',
  inputSchema: EXPORT_SCHEMA,
  annotations: { title: 'Export the diagram' },
  // The one asynchronous handler: an SVG needs a layout pass (see
  // ToolDefinition.handler). json and every refusal come back from the same
  // call, so the two formats cannot drift apart.
  handler: (args, ctx) => {
    const parsed = exportArgs(args, ctx);
    return isToolResult(parsed) ? parsed : runExport(parsed);
  },
};

// ---------------------------------------------------------------------------
// diagram_reset
// ---------------------------------------------------------------------------

const RESET_SCHEMA: PlainJsonSchema = {
  type: 'object',
  properties: {
    confirm: {
      type: 'boolean',
      description: 'Must be exactly true. Anything else refuses the reset.',
    },
  },
  required: ['confirm'],
  additionalProperties: false,
};

const diagramReset: ToolDefinition = {
  name: 'diagram_reset',
  strictArgs: true,
  description:
    'Clear the diagram back to an empty document. Requires {"confirm": true} ' +
    '— it refuses without it. The previous document is kept in history, so ' +
    'diagram_undo brings it back.',
  inputSchema: RESET_SCHEMA,
  annotations: { title: 'Clear the diagram', destructiveHint: true },
  handler: (args, ctx) => {
    // Strictly true: a client that sends "true" or 1 has not shown the user a
    // confirmation, and this is the one tool that destroys work. The refusal
    // is the tool's own — `--confirm` is not a thing an MCP client can type —
    // but the reset itself, and what it prints, is `diagram reset --confirm`.
    if (args['confirm'] !== true) {
      const loaded = loadDoc(ctx);
      const scale = loaded.ok ? renderCounts(loaded.doc) : 'the whole diagram';
      return refuse('reset needs confirm: true', [
        `this clears ${scale}`,
        'call again with {"confirm": true} if that is what you want',
      ]);
    }
    return runReset({ ...opts(ctx), confirm: true });
  },
};

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

/** The seven tools of spec §4.1, in the order they are advertised. */
export const TOOLS: readonly ToolDefinition[] = [
  diagramGet,
  diagramPatch,
  diagramUndo,
  diagramRedo,
  diagramView,
  diagramExport,
  diagramReset,
] as const;

/** Tool names, for error messages and tests. */
export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** Look a tool up by name. Undefined for anything not in the seven. */
export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Run a tool by name — the ONE dispatcher. An unknown name is the only thing
 * here that is a real error; everything else the agent can act on comes back
 * as ok:false text.
 *
 * Always a promise, even though six of the seven tools answer immediately.
 * Every MCP transport can await, so a second synchronous entry point would
 * buy nothing and cost the one thing that matters: a caller that took it
 * would silently lose `diagram_export {"format":"svg"}`.
 */
/**
 * Check one call against the tool's ADVERTISED input schema, before dispatch.
 *
 * Every schema here says `additionalProperties: false`, but nothing was
 * enforcing it: a handler read the two or three keys it knew and ignored the
 * rest. That is silent in the worst direction — `diagram_export
 * {"format":"svg","out":"arch.svg"}` (the CLI's flag name) answered
 * `ok — exported svg` and wrote to the DEFAULT path, so the agent's next
 * step failed several turns later naming the wrong cause. An advertised
 * contract the server does not keep is worse than no contract.
 *
 * ONLY unknown keys are checked here. A missing or wrongly-typed argument is
 * a semantic problem each tool answers better than a generic checker can —
 * diagram_reset names how much work the confirm would destroy, diagram_view
 * offers both of its two input shapes — so those stay with the handlers, and
 * `required` in a schema here means "the handler will say so", not "the
 * dispatcher rejects it". diagram_export's schema no longer claims `format`
 * is required: the CLI twin defaults to json and §4.2 promises they agree.
 */
export function checkArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): ToolResult | null {
  if (!tool.strictArgs) return null;
  const props = (tool.inputSchema['properties'] ?? {}) as Record<string, unknown>;
  const known = Object.keys(props);

  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    const bad = unknown[0] as string;
    const hint = tool.argHints?.[bad];
    return refuse(`unknown argument "${bad}" for ${tool.name}`, [
      ...(hint !== undefined ? [`did you mean "${hint}"?`] : []),
      known.length === 0
        ? `${tool.name} takes no arguments`
        : `accepted: ${known.join(', ')}`,
      'nothing was done — resend with the argument named above',
    ]);
  }

  return null;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: DiagramContext,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (tool === undefined) {
    return refuse(`unknown tool "${name}"`, [`available: ${TOOL_NAMES.join(', ')}`]);
  }
  const bad = checkArgs(tool, args);
  if (bad !== null) return bad;
  return tool.handler(args, ctx);
}
