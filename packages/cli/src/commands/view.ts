// commands/view.ts — `diagram view exec|eng|focus <id>` (spec Part 7, §4.2; M6 Step 15).
//
// A preset answers one question — which groups are collapsed — and this command
// writes that answer into doc.collapsed. So despite the read-only sounding name
// it is a DOCUMENT EDIT: it goes through the exclusive lock and it lands in
// history, which means `diagram undo` puts the previous view back like any other
// change. Nothing else about the document is touched, and no geometry is ever
// written (spec §1.3): collapsed is a list of ids, and the layout engine decides
// what that looks like.
//
// The resolver itself lives in core (view/presets.ts) so the CLI, the MCP tool
// and the viewer's status-bar buttons agree on what "exec" means. The
// collapse-and-edge-merge pass that turns a document plus that list into a
// drawable view (core's view/derive.ts) is NOT called here: this command's
// whole job is to record the answer. The viewer applies it on the next
// broadcast, and `diagram export svg` applies it when it draws. That is why
// the result below is three lines and says nothing about what will appear on
// screen — it already will.
//
// Everything happens inside one lock cycle, including reading the document and
// resolving the preset against it. Resolving against a copy read before the lock
// would let a concurrent patch that adds a group slip through the gap, and the
// view written would then be a view of a document that no longer exists. The
// lock is a file opened "wx" and is NOT reentrant, so nothing here may call
// commitDoc or applyAndCommit, which take it again.
//
// Runtime import of core by relative path — see commands/get.ts for why.

import * as fs from 'node:fs';
import type { Command } from 'commander';
import {
  readDoc,
  snapshotHistory,
  withLock,
  writeDocAtomic,
  type GraphDoc,
} from '../../../core/src/index.js';
import {
  existingGroupsLine,
  parseViewPreset,
  resolvePreset,
  VIEW_PRESET_NAMES,
} from '../../../core/src/index.js';
import {
  createContext,
  emit,
  failed,
  ok,
  plural,
  renderCounts,
  renderReadFailure,
  renderRejection,
  type CommandResult,
  type ContextOptions,
  type DiagramContext,
} from './context.js';

export interface ViewOptions extends ContextOptions {
  /** `focus` needs a group id; `exec` and `eng` ignore it. */
  id?: string;
}

/** What the write actually did — enough for the caller to render the result. */
export type ViewResult =
  | {
      ok: true;
      doc: GraphDoc;
      /** The label the output echoes: "exec", "eng", "focus:vpc-private". */
      preset: string;
      /** The group ids now in doc.collapsed. */
      collapsed: string[];
      /** False when the document already held exactly this view — no write, no snapshot. */
      changed: boolean;
    }
  | {
      ok: false;
      errors: string[];
      /** True when the document could not be read at all, rather than the request being wrong. */
      read: boolean;
    };

/** Same ids in the same order? collapsed is a list, so order counts as a change. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Apply a preset to the document on disk, under the lock.
 *
 * A document that does not exist yet is an error rather than a seeded empty
 * one: `diagram view` on nothing would silently create a diagram whose only
 * content is a view setting, and the agent's real problem — it is pointed at
 * the wrong directory — would stay hidden.
 */
export function applyView(ctx: DiagramContext, name: string, id?: string): ViewResult {
  return withLock(ctx.dir, (): ViewResult => {
    const current = readDoc(ctx.paths.graphFile);
    if (!current.ok) return { ok: false, errors: current.errors, read: true };
    const doc = current.doc;

    const parsed = parseViewPreset(name, id);
    if (!parsed.ok) {
      // A focus with no id (or a bad preset name) is one turn from correct if
      // the message carries the ids; without them the agent has to call get.
      const extra = name === 'focus' ? [existingGroupsLine(doc)] : [];
      return { ok: false, errors: [...parsed.errors, ...extra], read: false };
    }

    const resolved = resolvePreset(doc, parsed.preset);
    if (!resolved.ok) return { ok: false, errors: resolved.errors, read: false };

    const label =
      parsed.preset.preset === 'focus'
        ? `focus:${parsed.preset.id}`
        : parsed.preset.preset;

    return writeCollapsed(ctx, doc, resolved.collapsed, label);
  });
}

/**
 * The same write, for a caller that already knows which groups to collapse —
 * the diagram_view tool's `{"collapsed":[...]}` form (spec §4.1). It is the
 * one escape hatch from the presets, so it validates the ids itself and then
 * lands in exactly the same place, with the same wording and the same history
 * snapshot as a preset. MUST be called with the lock already held.
 */
function setExplicit(ctx: DiagramContext, doc: GraphDoc, ids: string[]): ViewResult {
  const known = new Set(doc.groups.map((g) => g.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      errors: [
        `unknown group ${unknown.map((u) => `"${u}"`).join(', ')} in collapsed.`,
        existingGroupsLine(doc),
      ],
      read: false,
    };
  }
  // De-duplicate: a repeated id says nothing, and the invariants read the list.
  return writeCollapsed(ctx, doc, [...new Set(ids)], 'collapsed');
}

/** `diagram_view {"collapsed":[...]}` — validate, then write, under the lock. */
export function applyCollapsed(ctx: DiagramContext, ids: string[]): ViewResult {
  return withLock(ctx.dir, (): ViewResult => {
    const current = readDoc(ctx.paths.graphFile);
    if (!current.ok) return { ok: false, errors: current.errors, read: true };
    return setExplicit(ctx, current.doc, ids);
  });
}

/**
 * Write doc.collapsed and snapshot it. The single write both entry points end
 * at, so a preset and an explicit list cannot behave differently.
 * MUST be called with the lock already held — it is not reentrant.
 */
function writeCollapsed(
  ctx: DiagramContext,
  doc: GraphDoc,
  collapsed: string[],
  label: string,
): ViewResult {
  if (sameList(doc.collapsed, collapsed)) {
    // Already this view: writing anyway would push a no-op onto history and
    // make `undo` feel broken.
    return { ok: true, doc, preset: label, collapsed, changed: false };
  }
  const next: GraphDoc = { ...doc, collapsed };
  // snapshotHistory reads the pre-change graph.json to seed snapshot 0000,
  // so it must run before the write, not after.
  snapshotHistory(ctx.dir, next);
  writeDocAtomic(ctx.dir, next);
  return { ok: true, doc: next, preset: label, collapsed, changed: true };
}

/**
 * The success shape, deliberately the same three-line rhythm as a patch result
 * (spec §4.1) — headline, what changed, standing graph size:
 *
 *   ok — view focus:vpc-private
 *   collapsed: edge-network, staging (2 of 4 groups)
 *   graph: 11 nodes, 4 groups, 9 edges
 */
export function renderView(result: Extract<ViewResult, { ok: true }>): string {
  const total = result.doc.groups.length;
  const collapsed =
    result.collapsed.length > 0
      ? `${result.collapsed.join(', ')} (${result.collapsed.length} of ${plural(total, 'group')})`
      : 'none — every group open';
  return [
    `ok — view ${result.preset}${result.changed ? '' : ' (unchanged)'}`,
    `collapsed: ${collapsed}`,
    `graph: ${renderCounts(result.doc)}`,
  ].join('\n');
}

/**
 * Turn any ViewResult into the output shape. Shared with the diagram_view MCP
 * tool, so the CLI and the tool report a view in the same three lines.
 *
 * A broken file is about the file, not about the request, so it gets the read
 * failure wording rather than blaming the preset the agent asked for.
 */
export function renderViewResult(ctx: DiagramContext, result: ViewResult): CommandResult {
  if (result.ok) return ok(renderView(result));
  return failed(
    result.read
      ? renderReadFailure(ctx.paths.graphFile, result.errors)
      : renderRejection(result.errors),
  );
}

/** `no diagram here yet` — the one thing view refuses to paper over. */
export function missingDiagram(ctx: DiagramContext): CommandResult {
  return failed(
    renderRejection([
      `no diagram at ${ctx.paths.graphFile}: apply a patch first`,
    ]),
  );
}

/** Build the `diagram view` output without printing it. */
export function runView(name: string, opts: ViewOptions = {}): CommandResult {
  const ctx = createContext(opts);
  if (!fs.existsSync(ctx.paths.graphFile)) return missingDiagram(ctx);
  return renderViewResult(ctx, applyView(ctx, name, opts.id));
}

/** The command body: print and set the exit code (never process.exit — see get.ts). */
export function viewCommand(name: string, opts: ViewOptions = {}): CommandResult {
  const result = runView(name, opts);
  emit(result);
  return result;
}

/** Register `diagram view` on the program. Called by bin/diagram.ts (M6 integration). */
/**
 * `diagram view --collapsed a b c` — the CLI twin of diagram_view's
 * `{"collapsed":[...]}` form (spec §4.1 gives the tool both input shapes, and
 * §4.2 says every tool has a CLI twin). Without it a shell-only agent — the
 * fallback the whole section exists for — can ask for exec/eng/focus but
 * cannot say "collapse exactly these two", and the explicit-list error wording
 * is exercised on one surface only.
 *
 * An empty list (`--collapsed` with no ids) expands everything, exactly as
 * `{"collapsed": []}` does.
 */
export function runViewCollapsed(ids: string[], opts: ContextOptions = {}): CommandResult {
  const ctx = createContext(opts);
  if (!fs.existsSync(ctx.paths.graphFile)) return missingDiagram(ctx);
  return renderViewResult(ctx, applyCollapsed(ctx, ids));
}

export function registerView(program: Command): void {
  program
    .command('view')
    .argument('[preset]', `view preset: ${VIEW_PRESET_NAMES.join(' | ')}`)
    .argument('[id]', 'group id to centre on (required by the focus preset)')
    .description('set which groups are collapsed, by preset or by explicit list')
    // OPTIONAL variadic, so bare `--collapsed` yields [] and reaches the
    // empty-list branch runViewCollapsed documents. As a required variadic
    // commander refused it before the action ran, and the documented way to
    // expand everything from the shell did not exist.
    .option('--collapsed [ids...]', 'collapse exactly these group ids, or none (instead of a preset)')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action(
      (
        preset: string | undefined,
        id: string | undefined,
        opts: { dir?: string; collapsed?: string[] | boolean },
      ) => {
        const dirOpt = opts.dir !== undefined ? { dir: opts.dir } : {};
        if (opts.collapsed !== undefined) {
          // An optional variadic with no values arrives as `true`, not [].
          const ids = Array.isArray(opts.collapsed) ? opts.collapsed : [];
          emit(runViewCollapsed(ids, dirOpt));
          return;
        }
        if (preset === undefined) {
          emit(
            failed(
              renderRejection([
                `diagram view needs a preset (${VIEW_PRESET_NAMES.join(' | ')}) or --collapsed <ids...>`,
              ]),
            ),
          );
          return;
        }
        viewCommand(preset, {
          ...dirOpt,
          ...(id !== undefined ? { id } : {}),
        });
      },
    );
}
