// commands/export.ts — `diagram export json|svg [--out path] [--full]` (spec §4.2, §2.5, Step 16).
//
// Two formats write a file, and one deliberately does not:
//
//   json  the document exactly as it is on disk. The round-trippable
//         artifact: it is what you commit, diff, hand to a converter, or
//         feed back through `diagram import`.
//   svg   the diagram as the viewer draws it — laid out headlessly through
//         the ONE layout path (packages/viewer/src/layout/runLayout.ts) and
//         rendered by the headless renderer (packages/viewer/src/export/).
//   png   refused, with a pointer. See PNG below.
//
// Output paths:
//   json  default <.diagram>/out.json   (sibling of out.svg, so both exports
//         land in the ignored directory rather than dropping stray files in
//         the project root)
//   svg   default <.diagram>/out.svg    (spec §2.5)
// --out is resolved against the current working directory, not .diagram/,
// because `--out arch.json` from an agent means "next to my code".
//
// -------------------------------------------------------------------------
// PNG (spec Step 16 / Part 13 item 1)
// -------------------------------------------------------------------------
// PNG at 2× is a BROWSER capability: it is the viewer drawing its own SVG
// onto a canvas at 2× and calling toBlob — the [PNG 2×] button in the status
// strip (packages/viewer/src/export/save.ts). Producing one in Node needs a
// rasteriser (resvg, sharp, a headless browser), and Part 13 lists that as a
// FUTURE EXTENSION — and §1.6 forbids adding dependencies on a whim. The two dishonest answers are both worse than refusing: writing an
// SVG with a .png name gives the agent a file no image viewer opens, and
// silently falling back to SVG makes `export png && convert` fail three
// steps later with an error that names the wrong cause. So png is refused in
// one line that says where PNG actually lives.
//
// -------------------------------------------------------------------------
// WHICH DOCUMENT svg DRAWS (the derived view, by default)
// -------------------------------------------------------------------------
// `diagram view exec` stores doc.collapsed, and the viewer honours it. An
// `export svg` that ignored it would mean the file on disk and the picture on
// screen are different diagrams — and the agent that just ran `view exec` to
// produce a boardroom picture would get the engineering one, with no line of
// output saying so. So svg exports deriveView(doc) by default: WYSIWYG, and
// the flag exists for the other case. `--full` (MCP: {"full": true}) ignores
// doc.collapsed and draws every group open.
//
// json is the opposite default and has no derived form: deriveView deletes
// groups and invents stand-in nodes, so a derived document is a PICTURE
// serialised, not the document — round-tripping it through `diagram import`
// would silently destroy the collapsed groups' contents. json is always the
// stored document, and --full is a no-op there.
//
// -------------------------------------------------------------------------
// HOW THE RENDERER IS BOUND
// -------------------------------------------------------------------------
// Statically, by ordinary import, exactly the way this package imports core.
// packages/cli/tsconfig.build.json has rootDir `packages/`, so tsc follows
// the import and compiles the viewer's export subtree alongside the CLI's
// and core's, emitting it at dist/viewer/src/export/toSvg.js — where this
// module's relative specifier resolves unchanged. Two things make that work
// and are worth naming, because breaking either brings back a runtime-only
// failure that no test would catch:
//
//   * every VALUE import that crosses a package inside the compiled tree is
//     RELATIVE (`../../../core/src/...`). A package-name specifier survives
//     compilation verbatim and resolves to a .ts entry point Node cannot
//     load. `import type` is erased, so type-only package imports are fine —
//     which is why most of the viewer needs no change.
//   * every relative specifier carries `.js`. Vite does not care; Node does.
//
// tsconfig.json therefore carries `jsx` and the DOM lib: the renderer
// serialises the viewer's own React components and measures text against a
// canvas when one exists. There is no injection seam and no dynamic probe —
// one binding, checked by the compiler, so `export svg` cannot be "wired" in
// the tests and unwired in the binary.
//
// Runtime import of core by relative path: see the note in commands/patch.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import type { GraphDoc } from '../../../core/src/index.js';
import { exportSvg } from '../../../viewer/src/export/toSvg.js';
import {
  createContext,
  emit,
  failed,
  loadDoc,
  ok,
  rejectedRead,
  renderReadFailure,
  renderCounts,
  renderViewLine,
  type CommandOutput,
  type ContextOptions,
  type DiagramContext,
} from './context.js';

/** Formats that write a file. png is understood but refused — see the header. */
export const EXPORT_FORMATS = ['json', 'svg'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions extends ContextOptions {
  /** "json" (default), "svg", or anything else — which is refused. */
  format?: string;
  /** Destination path, resolved against the cwd. Defaults per format. */
  out?: string;
  /**
   * svg only: draw every group open, ignoring the stored collapsed view.
   * Default false — svg exports what the viewer shows.
   */
  full?: boolean;
}

/**
 * The json export's default filename. Exported because the diagram_export MCP
 * tool advertises it in two separate strings (its description and its input
 * schema), and two hand-written copies of a filename is how the surface ends
 * up telling the agent one name and writing another.
 */
export const DEFAULT_JSON_OUT = 'out.json';

/** Where a format writes when --out is not given. */
export function defaultOutPath(ctx: DiagramContext, format: ExportFormat): string {
  return format === 'svg' ? ctx.paths.svgFile : path.join(ctx.dir, DEFAULT_JSON_OUT);
}

// ---------------------------------------------------------------------------
// Rendering the result
// ---------------------------------------------------------------------------

/** The document serialised for export: the same two-space JSON as graph.json. */
function serialise(doc: GraphDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// The `view:` line under an svg export — which picture is in that file —
// comes from the spine (context.ts's renderViewLine), so `get` and this
// command cannot describe the same document differently. Without it two
// exports of one document are indistinguishable on disk and in the
// transcript, and "why does my SVG have four boxes" costs the agent a turn.

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Everything that can be decided without rendering: the format, the document,
 * the destination. Either the whole answer already (`output`), or the work
 * left to do.
 */
type ExportStep =
  | { output: CommandOutput }
  | { ctx: DiagramContext; doc: GraphDoc; out: string; full: boolean };

function prepareExport(opts: ExportOptions): ExportStep {
  const format = opts.format === undefined || opts.format === '' ? 'json' : opts.format;

  if (format === 'png') {
    return {
      output: rejectedRead([
        'png needs a rasteriser this build does not have (spec Part 13 lists it as a future extension)',
        'PNG at 2× is a viewer capability: run `diagram serve`, open it, and press [PNG 2×] in the status bar',
        'or `diagram export svg` — SVG is resolution-independent and converts cleanly',
      ]),
    };
  }
  if (format !== 'json' && format !== 'svg') {
    return {
      output: rejectedRead([
        `unknown export format "${format}" — formats: json, svg (png: the viewer's [PNG 2×] button)`,
      ]),
    };
  }

  const ctx = createContext({ ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
  const loaded = loadDoc(ctx);
  // The document is broken, not the request. get, check and view all say
  // "cannot read <path>" for this; saying "rejected" here would give the
  // agent two shapes for one condition, and it must pattern-match the one it
  // has to fix — the file.
  if (!loaded.ok) return { output: failed(renderReadFailure(ctx.paths.graphFile, loaded.errors)) };
  // Exporting an empty document silently produces a file the agent thinks is
  // its diagram — a 48x48 SVG of six empty layers, or a JSON document with no
  // elements. Say what is missing instead. `diagram init` writes a real but
  // empty graph.json, so "the file is absent" and "the file has nothing in
  // it" are BOTH this case; they get different wording because the next move
  // differs (check --dir vs. start patching).
  if (!loaded.existed) {
    return {
      output: rejectedRead([
        `no diagram at ${ctx.paths.graphFile} — run \`diagram patch\` to create one`,
      ]),
    };
  }
  if (loaded.doc.nodes.length === 0 && loaded.doc.groups.length === 0) {
    return {
      output: rejectedRead([
        `the diagram at ${ctx.paths.graphFile} is empty — add nodes with \`diagram patch\` before exporting`,
      ]),
    };
  }

  const out =
    opts.out !== undefined && opts.out !== ''
      ? path.resolve(opts.out)
      : defaultOutPath(ctx, format);

  if (format === 'json') {
    // --full is meaningless here (json is always the stored document), and
    // saying so on every call would be a line the agent pays for and ignores.
    return { output: write(out, serialise(loaded.doc), 'json', [`graph: ${renderCounts(loaded.doc)}`]) };
  }
  return { ctx, doc: loaded.doc, out, full: opts.full === true };
}

/** Write the bytes, or say why not. The only place either format touches disk. */
function write(out: string, body: string, format: string, tail: string[]): CommandOutput {
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body, 'utf8');
  } catch (e) {
    return rejectedRead([`could not write ${out}: ${(e as NodeJS.ErrnoException).message}`]);
  }
  return ok([`ok — exported ${format}`, `wrote: ${out}`, ...tail].join('\n'));
}

/**
 * `diagram export`. Exits 1 on anything that did not produce a file, so an
 * agent scripting `diagram export svg --out arch.svg && ...` cannot walk on
 * believing the file exists.
 *
 * Async because SVG needs a layout pass and ELK is async. json never awaits
 * anything real, so the two formats still share one code path and one set of
 * refusals rather than growing a second, drifting implementation.
 */
export async function runExport(opts: ExportOptions = {}): Promise<CommandOutput> {
  const step = prepareExport(opts);
  if ('output' in step) return step.output;

  // The one decision this command makes about the picture. --full says [] —
  // not "leave it to the default" — so the renderer cannot fall back to
  // doc.collapsed behind the flag's back.
  const collapsed = step.full ? [] : step.doc.collapsed;

  let svg: string;
  try {
    svg = await exportSvg(step.doc, { collapsed });
  } catch (e) {
    // The renderer throws for exactly one class of thing an agent can act
    // on — text measurement that is not answering honestly, which would
    // otherwise emit a heap of identical minimum-width boxes with no error
    // at all. Anything else here is a bug. Either way the agent needs the
    // one line that says no file exists.
    return rejectedRead([`svg render failed: ${(e as Error).message}`, 'nothing was written']);
  }

  return write(step.out, svg, 'svg', [
    renderViewLine(step.doc, step.full),
    `graph: ${renderCounts(step.doc)}`,
  ]);
}

/** Register `diagram export` on the program. The integrator calls this. */
export function registerExport(program: Command): void {
  program
    .command('export')
    .description('write the diagram to a file (json or svg)')
    .argument('[format]', 'json or svg', 'json')
    .option('--out <path>', 'destination file (default: .diagram/out.json or .diagram/out.svg)')
    .option('--full', 'svg: draw every group open, ignoring the stored collapsed view')
    .option('--dir <path>', 'the .diagram directory (default: $DIAGRAM_DIR or ./.diagram)')
    .action(async (format: string, opts: { out?: string; full?: boolean; dir?: string }) => {
      emit(
        await runExport({
          format,
          ...(opts.out !== undefined ? { out: opts.out } : {}),
          ...(opts.full !== undefined ? { full: opts.full } : {}),
          ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        }),
      );
    });
}
