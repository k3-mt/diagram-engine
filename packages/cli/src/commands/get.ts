// commands/get.ts — `diagram get` (spec §4.1, §4.2; M6 Step 15).
//
// Prints the compact text table — the same string diagram_get returns — so an
// agent with no MCP support can read the document with one shell call.
//
// The table itself comes from core's toTable() and nothing here reformats it.
// That is deliberate: the CLI and the MCP tool must hand the agent byte-for-byte
// the same picture, and the only way to guarantee that is for both to call the
// one renderer. Entity fields and per-node meta already appear in toTable when
// the document uses them (the built schema has both; the spec's §4.1 example
// predates them), so `get` inherits them for free and adds no columns of its own.
//
// Two additions, both trailing lines and both about something the table cannot
// show:
//
//  * when .diagram/graph.json does not exist yet, because "an empty table" and
//    "no diagram here at all" are different situations and an agent that cannot
//    tell them apart guesses. It costs nothing once a document exists.
//  * when doc.collapsed is non-empty (M7), because the table lists the STORED
//    document while the viewer and `export svg` both draw the DERIVED one. An
//    agent that ran `diagram view exec` and then read this table would
//    otherwise describe ten nodes and twelve edges over a picture showing four
//    and three, with nothing in the output to contradict it. The line is the
//    same one `export svg` prints, from the same function in the spine.
//
// `--view` (diagram_get {"view": true}) goes further and prints the table OF
// THE DERIVED DOCUMENT: the collapsed stand-ins with their component counts and
// the merged edges with their `×3`. That is a picture serialised, not the
// document — which is why it is a flag and not the default. The default must
// stay the stored document, because that is what the agent edits.
//
// Runtime import of core by relative path (not '@diagram-engine/core'): core is
// consumed as TS source in the workspace and the CLI build compiles core's src
// alongside its own, so a relative specifier resolves from src/ under vitest and
// from dist/ after a build.

import type { Command } from 'commander';
import { toTable } from '../../../core/src/index.js';
import { deriveView, isCollapsedGroupNode } from '../../../core/src/view/derive.js';
import {
  createContext,
  emit,
  failed,
  loadDoc,
  ok,
  renderReadFailure,
  renderViewLine,
  type CommandResult,
  type ContextOptions,
} from './context.js';

export interface GetOptions extends ContextOptions {
  /**
   * Print the DERIVED view — collapsed groups as one box, merged edges with
   * their counts — instead of the stored document. Read-only either way.
   */
  view?: boolean;
}

/**
 * The one line appended when there is nothing to look at. A diagram nobody has
 * drawn in yet renders as three empty sections, which reads like a bug, and an
 * agent that cannot tell "empty" from "wrong --dir" guesses — so the two cases
 * say different things and both say what to do next.
 */
function emptyNote(graphFile: string, existed: boolean): string {
  return existed
    ? '(empty diagram — add nodes with `diagram patch` / diagram_patch)'
    : `(empty diagram — no document yet at ${graphFile}; add nodes with \`diagram patch\` / diagram_patch)`;
}

/**
 * Build the `diagram get` output. A missing document is not a failure: the
 * empty table plus a note is the honest answer, and the agent's next move
 * (start drawing) is the same either way.
 */
export function runGet(opts: GetOptions = {}): CommandResult {
  const ctx = createContext(opts);
  const loaded = loadDoc(ctx);
  if (!loaded.ok) {
    return failed(renderReadFailure(ctx.paths.graphFile, loaded.errors));
  }
  const doc = loaded.doc;
  const derived = opts.view === true;
  // --view tabulates the drawn document. deriveView is pure and defaults to
  // doc.collapsed, so this is the same picture the viewer and `export svg`
  // produce, from the same call.
  const drawn = derived ? deriveView(doc) : doc;
  const lines = [toTable(drawn)];
  if (derived) {
    // toTable is the canonical §4.1 shape and has no `note` column, so the
    // stand-in's component count — the one thing a collapsed box says about
    // what it is hiding — would otherwise be dropped. One extra line rather
    // than a new column, because the table's shape is a pinned contract.
    const boxes = drawn.nodes.filter(isCollapsedGroupNode);
    if (boxes.length > 0) {
      lines.push(
        `collapsed: ${boxes.map((n) => `${n.id} (${n.note ?? 'collapsed group'})`).join(', ')}`,
      );
    }
  }
  if (doc.nodes.length === 0 && doc.groups.length === 0 && doc.edges.length === 0) {
    lines.push(emptyNote(ctx.paths.graphFile, loaded.existed));
  }
  if (doc.collapsed.length > 0) {
    // Which picture this is, and how to get the other one. Only printed when
    // a view is actually set, so the common case pays nothing.
    lines.push(
      renderViewLine(doc),
      derived
        ? 'showing: the drawn view (`diagram get` without --view lists the stored document)'
        : 'showing: the stored document (`diagram get --view` lists what the reader sees)',
    );
  }
  return ok(lines.join('\n'));
}

/**
 * The command body: print and set the exit code. `process.exitCode` rather
 * than `process.exit()` so nothing is lost from a half-flushed stdout pipe,
 * and so importing this module can never kill a test runner.
 */
export function getCommand(opts: GetOptions = {}): CommandResult {
  const result = runGet(opts);
  emit(result);
  return result;
}

/** Register `diagram get` on the program. Called by bin/diagram.ts (M6 integration). */
export function registerGet(program: Command): void {
  program
    .command('get')
    .description('print the current diagram as a compact text table')
    .option('--view', 'print the drawn view (groups collapsed, edges merged) instead')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action((opts: { dir?: string; view?: boolean }) => {
      getCommand({
        ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        ...(opts.view !== undefined ? { view: opts.view } : {}),
      });
    });
}
