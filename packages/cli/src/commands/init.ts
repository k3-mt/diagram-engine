// commands/init.ts — `diagram init` (spec §2.5, §4.1, §4.3, §4.4; M6 Step 15).
//
// The first command a developer runs. It installs the engine into an existing
// project: the MCP server entry, the .gitignore lines, the CLAUDE.md / AGENTS.md
// pointer block, the Claude Code skill, and a seed .diagram/graph.json.
//
// Two properties matter more than anything else here, because this command
// writes into files the developer already owns:
//
//   IDEMPOTENT — running it twice changes nothing the second time. Every block
//     we own is delimited by markers and REWRITTEN between them, so an edit to
//     the block text propagates on the next init without ever duplicating.
//   NEVER CLOBBER — .mcp.json is merged key by key (other servers survive),
//     CLAUDE.md / AGENTS.md keep every line outside our markers, and an
//     existing graph.json is left exactly as it is. If .mcp.json is present but
//     unparseable we refuse to touch it and say so, rather than overwriting
//     work we cannot read.
//
// --agent claude | codex | cursor (spec Part 11, "MCP config differs per agent").
// What actually differs:
//
//   claude  Claude Code reads a project-scoped `.mcp.json` and launches the
//           server with the project root as cwd. It does NOT expand
//           `${workspaceFolder}`, so we omit the env block entirely and let the
//           server's own resolveDiagramDir() fall back to <cwd>/.diagram. A
//           literal "${workspaceFolder}" would otherwise become a directory of
//           that name. Claude Code is also the only agent that gets the skill
//           wired to it (.claude/skills/diagram/SKILL.md is a Claude Code
//           format), though we write it for every agent — it is a harmless
//           markdown file and developers switch agents.
//   cursor  Cursor expands `${workspaceFolder}`, so the env block from spec
//           §4.1 is written verbatim. Cursor reads `.cursor/mcp.json` for
//           project scope, so the same server entry is merged into that file
//           as well as `.mcp.json`.
//   codex   Codex CLI takes MCP servers from TOML in ~/.codex/config.toml —
//           outside the project, and this command never writes outside the
//           project directory. So we write the same `.mcp.json` (harmless, and
//           several tools read it) and print the one TOML block to paste.
//
// The module prints only from initCommand(); runInit() is pure I/O + a result
// record, so the tests can assert on structure rather than on scraped stdout.

import * as fs from 'node:fs';
import * as path from 'node:path';
// Runtime import of core by relative path (not '@diagram-engine/core'): core is
// consumed as TS source in the workspace and the CLI build compiles core's src
// alongside its own (see tsconfig.build.json), so a relative specifier resolves
// both from src/ under vitest and from dist/ after a build.
import { diagramPaths, emptyDoc, writeDocAtomic } from '../../../core/src/index.js';
import { compactRules, loadRules } from '../../../core/src/index.js';
import type { Command } from 'commander';

/** The agents whose MCP configuration we know how to write (spec Part 11). */
export const INIT_AGENTS = ['claude', 'codex', 'cursor'] as const;
export type InitAgent = (typeof INIT_AGENTS)[number];

export interface InitOptions {
  /**
   * The PROJECT directory to install into. init writes files across the whole
   * project (.mcp.json, CLAUDE.md, .claude/), so the root is the only sensible
   * unit — which is why the flag is `--root` here and NOT `--dir`. Everywhere
   * else in the CLI `--dir` means the .diagram/ directory, and one flag that
   * means two different directories depending on the subcommand is a trap.
   * Default: process.cwd().
   */
  root?: string;
  /** @deprecated Older name for `root`; `root` wins when both are given. */
  dir?: string;
  /** Which agent's MCP config to write. Default: 'claude'. */
  agent?: InitAgent;
}

/** What happened to one file. `skipped` always carries a reason. */
export type InitStatus = 'created' | 'updated' | 'merged' | 'unchanged' | 'skipped';

export interface InitFileResult {
  /** Path relative to the project root, with forward slashes. */
  file: string;
  status: InitStatus;
  /** Present only on `skipped`: why we declined to write. */
  reason?: string;
}

export interface InitResult {
  /** The absolute project root that was written into. */
  root: string;
  agent: InitAgent;
  files: InitFileResult[];
  /** Extra lines for the summary (currently the codex TOML pointer). */
  notes: string[];
}

/** Type guard for the --agent value, so a typo fails loudly and early. */
export function isInitAgent(value: string): value is InitAgent {
  return (INIT_AGENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The content we install
// ---------------------------------------------------------------------------

/** Markers delimiting our block in a markdown file. */
const MD_BEGIN = '<!-- diagram-engine:begin — managed by `diagram init`, edits between these markers are overwritten -->';
const MD_END = '<!-- diagram-engine:end -->';

/** Markers delimiting our block in .gitignore (# comments, not HTML). */
const GI_BEGIN = '# diagram-engine:begin — managed by `diagram init`';
const GI_END = '# diagram-engine:end';

/**
 * The .gitignore body. graph.json is deliberately absent: it IS committed
 * (spec §2.5). Everything here is transient — replayable history, the last
 * error dump, the exported svg, and the read-modify-write lock file.
 */
const GITIGNORE_BODY = [
  '.diagram/history/',
  '.diagram/errors.txt',
  // Both export targets. out.json is a full duplicate of graph.json that
  // would otherwise be committed and drift; out.svg is a rendering of it.
  // Neither is a source of truth, and both are rewritten on every export.
  '.diagram/out.json',
  '.diagram/out.svg',
  '.diagram/.lock',
  // Chaos predictions and results (spec §18.6). They are computed FROM the
  // document, never part of it (C5), and each one is only meaningful against
  // the document hash it was computed under — a stale prediction in a commit
  // is worse than no prediction, so the directory is ignored from day one.
  '.diagram/chaos/',
].join('\n');

/**
 * The one worked example of a patch, used by the markdown block and the skill.
 *
 * It is a REAL patch: `summary` is required by GraphPatchSchema and `parent`
 * is a required key on every node and group (null means top level). The
 * example shipped before this said `{"ops":[...]}` with neither, so an agent
 * copying it was rejected twice — once for the missing summary, and once more
 * after it invented a parent group to satisfy "expected string, received
 * undefined". An example that cannot work is worse than no example.
 */
const PATCH_EXAMPLE =
  'diagram patch --stdin <<\'JSON\'\n' +
  '{"summary":"add the web client",\n' +
  ' "ops":[{"op":"addNode","node":{"id":"web","type":"client",\n' +
  '         "label":"Web app","parent":null}}]}\n' +
  'JSON';

/**
 * The CLAUDE.md / AGENTS.md block.
 *
 * It carries THE RULES THEMSELVES, not a pointer to them. Spec §4.4 names four
 * surfaces for one canonical text — the MCP tool description, `diagram rules`,
 * this file, and the skill — and three of them carrying the text while this
 * one says "go and run a command" is the milestone's exit criterion
 * half-delivered: an agent whose whole context is CLAUDE.md, with no MCP
 * server connected and no reason to shell out, would never see rule 8 (do not
 * invent), rule 1 (reuse ids) or rule 4 (edge direction) — precisely the
 * failures the rules exist to prevent. The `diagram` binary is also not
 * guaranteed to be on PATH in a fresh project, so the pointer could dead-end.
 *
 * The compact form is used rather than the full text: it is the same rules,
 * compressed the same way the MCP tool description compresses them (~2.7KB,
 * bounded by a test), and this file is loaded on every turn.
 *
 * The last paragraph is spec §4.3, path C: an agent that edits graph.json by
 * hand needs to know how to find out whether what it wrote was accepted. It
 * says `diagram check` FIRST, because errors.txt is only ever written by a
 * running `diagram serve` — its absence proves nothing on its own.
 */
function markdownBody(): string {
  return [
    '## Diagrams',
    '',
    'This project has a diagram engine. The document is `.diagram/graph.json`;',
    'the picture is rendered by `diagram serve` and updates live.',
    '',
    'Preferred ways in, best first:',
    '',
    '1. The MCP tools `diagram_get` and `diagram_patch` (see `.mcp.json`).',
    '2. The CLI: `diagram get`, `diagram patch --stdin`, `diagram undo`.',
    '3. Editing `.diagram/graph.json` directly — last resort.',
    '',
    '```bash',
    PATCH_EXAMPLE,
    '```',
    '',
    'IF YOU EDIT `.diagram/graph.json` DIRECTLY: the engine does not repaint an',
    'invalid document. Run `diagram check` after writing — it is the reliable',
    'answer and it needs nothing running. While `diagram serve` is up, the same',
    'failures are also dumped to `.diagram/errors.txt` (removed again as soon as',
    'the document is valid), but with no server running that file is not written',
    'at all, so its absence proves nothing.',
    '',
    'The rules below are the canonical text (`diagram rules` prints the full',
    'version; `diagram rules --erd` covers entity-relationship diagrams).',
    '',
    '```text',
    compactRules(),
    '```',
  ].join('\n');
}

/**
 * The Claude Code skill (spec §4.4). Frontmatter needs a `name` and a
 * `description` that says WHEN to use it — the description is the only thing
 * the agent sees until it decides to load the skill, so it names the triggers.
 * The body is the canonical rules text verbatim, plus how to actually run.
 */
function skillBody(): string {
  const frontmatter = [
    '---',
    'name: diagram',
    'description: >-',
    '  Build or edit this project\'s architecture and database diagrams through the',
    '  diagram engine. Use whenever the user asks to draw, diagram, sketch, map or',
    '  visualise the system, its services, its infrastructure or its schema; when',
    '  they ask to add, remove or reconnect something in an existing diagram; and',
    '  before editing .diagram/graph.json by hand.',
    '---',
    '',
  ].join('\n');

  const howToRun = [
    '',
    '---',
    '',
    '## How to run it',
    '',
    'Prefer the MCP tools if they are connected: `diagram_get` to read the current',
    'state, `diagram_patch` to change it. Otherwise use the CLI twins:',
    '',
    '```bash',
    'diagram get                                # the compact table',
    'diagram undo | diagram redo                # step the history',
    'diagram check                              # validate after a hand edit',
    'diagram serve                              # open the live viewer',
    'diagram rules --erd                        # the ERD rules',
    '```',
    '',
    'Applying a patch — every patch carries a `summary`, and every node and',
    'group carries an explicit `parent` (`null` for top level):',
    '',
    '```bash',
    PATCH_EXAMPLE,
    '```',
    '',
    'A rejected patch prints the errors and applies nothing. Read them, fix the',
    'ops, retry once.',
    '',
  ].join('\n');

  return frontmatter + loadRules().trimEnd() + '\n' + howToRun;
}

/**
 * The name of the local binary the MCP entry launches.
 *
 * NOT `npx -y diagram-engine mcp`, which is what spec §4.1 writes. This
 * package is private and unpublished, and `diagram-engine` is already taken on
 * npm by an unrelated React rendering library that ships no `bin` — so that
 * config downloads a stranger's package and then fails to start a server, and
 * a missing MCP server is invisible to an agent: the tools simply never
 * appear. Launching the local binary instead either works (it is on PATH after
 * `npm link` / a global install) or fails loudly with "command not found",
 * which is a failure a human can act on. Change this to an npx invocation on
 * the day the package is actually published under a name we own.
 */
export const MCP_COMMAND = 'diagram';

/** Told to the developer whenever we write that entry — see MCP_COMMAND. */
const MCP_PATH_NOTE =
  `\`${MCP_COMMAND}\` must be on PATH for the MCP server to start ` +
  '(the package is not on npm yet: `npm link` in the engine repo, or install it globally)';

/** The MCP server entry (spec §4.1), shaped per agent (see file header). */
export function mcpServerEntry(agent: InitAgent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    command: MCP_COMMAND,
    args: ['mcp'],
  };
  // Only Cursor expands ${workspaceFolder}. For claude and codex the server
  // starts with the project root as cwd and resolves <cwd>/.diagram itself, so
  // an unexpanded literal would be strictly worse than no env at all.
  if (agent === 'cursor') {
    base['env'] = { DIAGRAM_DIR: '${workspaceFolder}/.diagram' };
  }
  return base;
}

/** The block to paste into ~/.codex/config.toml — printed, never written. */
function codexTomlNote(): string {
  return `codex: add to ~/.codex/config.toml — [mcp_servers.diagram] command = "${MCP_COMMAND}", args = ["mcp"]`;
}

// ---------------------------------------------------------------------------
// Primitives: marked blocks and JSON merge
// ---------------------------------------------------------------------------

/**
 * Insert or rewrite our marked block in `original`. Returns the new text and
 * whether anything changed — the caller turns that into created/updated/
 * unchanged. Text outside the markers is never touched.
 */
export function upsertBlock(
  original: string | null,
  body: string,
  begin: string,
  end: string,
): { text: string; changed: boolean } {
  const block = `${begin}\n${body}\n${end}`;

  if (original === null || original.trim() === '') {
    return { text: `${block}\n`, changed: true };
  }

  const from = original.indexOf(begin);
  const to = original.indexOf(end, from + begin.length);
  if (from !== -1 && to !== -1) {
    const next = original.slice(0, from) + block + original.slice(to + end.length);
    return { text: next, changed: next !== original };
  }

  // No markers yet: append, keeping exactly one blank line as separation and
  // never disturbing what the developer already wrote above.
  const prefix = original.endsWith('\n') ? original : `${original}\n`;
  return { text: `${prefix}\n${block}\n`, changed: true };
}

/** Read a file, or null when it does not exist. */
function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write a file, creating parent directories. */
function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * Merge the diagram entry into an mcpServers-shaped JSON file. Unrelated
 * servers and unrelated top-level keys are preserved byte-for-byte in meaning
 * (we re-serialise, so formatting normalises to 2-space JSON, but no data is
 * dropped). An unparseable file is left alone and reported as skipped.
 */
function mergeMcpFile(file: string, rel: string, agent: InitAgent): InitFileResult {
  const entry = mcpServerEntry(agent);
  const existing = readIfExists(file);

  if (existing === null) {
    writeFile(file, `${JSON.stringify({ mcpServers: { diagram: entry } }, null, 2)}\n`);
    return { file: rel, status: 'created' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return {
      file: rel,
      status: 'skipped',
      reason: 'not valid JSON — add the "diagram" server by hand',
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      file: rel,
      status: 'skipped',
      reason: 'not a JSON object — add the "diagram" server by hand',
    };
  }

  const doc = parsed as Record<string, unknown>;
  const rawServers = doc['mcpServers'];
  const servers: Record<string, unknown> =
    typeof rawServers === 'object' && rawServers !== null && !Array.isArray(rawServers)
      ? { ...(rawServers as Record<string, unknown>) }
      : {};

  const already = JSON.stringify(servers['diagram']) === JSON.stringify(entry);
  servers['diagram'] = entry;
  const next = `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`;

  if (already && next === existing) return { file: rel, status: 'unchanged' };
  writeFile(file, next);
  return { file: rel, status: already ? 'updated' : 'merged' };
}

/** Install a marked block into a markdown or gitignore file. */
function upsertFile(
  file: string,
  rel: string,
  body: string,
  begin: string,
  end: string,
): InitFileResult {
  const existing = readIfExists(file);
  const { text, changed } = upsertBlock(existing, body, begin, end);
  if (!changed) return { file: rel, status: 'unchanged' };
  writeFile(file, text);
  return { file: rel, status: existing === null ? 'created' : 'updated' };
}

/** Write a file we own outright (the skill), but only when it would change. */
function writeOwnedFile(file: string, rel: string, text: string): InitFileResult {
  const existing = readIfExists(file);
  if (existing === text) return { file: rel, status: 'unchanged' };
  writeFile(file, text);
  return { file: rel, status: existing === null ? 'created' : 'updated' };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Install the engine into a project. Creates nothing outside `root`, and
 * overwrites nothing the developer wrote.
 */
export function runInit(opts: InitOptions = {}): InitResult {
  const root =
    // `root` is the name; `dir` is the older one kept for callers that predate
    // the rename (the CLI itself only ever passes `root`).
    opts.root !== undefined && opts.root !== ''
      ? path.resolve(opts.root)
      : opts.dir !== undefined && opts.dir !== ''
        ? path.resolve(opts.dir)
        : process.cwd();
  const agent: InitAgent = opts.agent ?? 'claude';
  fs.mkdirSync(root, { recursive: true });

  const files: InitFileResult[] = [];
  const notes: string[] = [];

  // 1. MCP config (spec §4.1).
  files.push(mergeMcpFile(path.join(root, '.mcp.json'), '.mcp.json', agent));
  if (agent === 'cursor') {
    // Cursor's project scope is .cursor/mcp.json; .mcp.json alone is not read.
    files.push(
      mergeMcpFile(path.join(root, '.cursor', 'mcp.json'), '.cursor/mcp.json', agent),
    );
  }
  if (agent === 'codex') notes.push(codexTomlNote());
  // Say it out loud: a missing MCP server is invisible from inside an agent —
  // the tools just never appear — so the one prerequisite goes in the summary.
  notes.push(MCP_PATH_NOTE);

  // 2. .gitignore (spec §2.5) — graph.json is committed, so it is not here.
  files.push(
    upsertFile(path.join(root, '.gitignore'), '.gitignore', GITIGNORE_BODY, GI_BEGIN, GI_END),
  );

  // 3. Agent instructions (spec §4.3, §4.4).
  const md = markdownBody();
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    files.push(upsertFile(path.join(root, name), name, md, MD_BEGIN, MD_END));
  }

  // 4. The Claude Code skill (spec §4.4).
  files.push(
    writeOwnedFile(
      path.join(root, '.claude', 'skills', 'diagram', 'SKILL.md'),
      '.claude/skills/diagram/SKILL.md',
      skillBody(),
    ),
  );

  // 5. Seed document (spec §2.5). Never overwrite an existing diagram.
  const diagramDir = path.join(root, '.diagram');
  const graphFile = diagramPaths(diagramDir).graphFile;
  if (fs.existsSync(graphFile)) {
    files.push({ file: '.diagram/graph.json', status: 'unchanged' });
  } else {
    fs.mkdirSync(diagramDir, { recursive: true });
    writeDocAtomic(diagramDir, emptyDoc());
    files.push({ file: '.diagram/graph.json', status: 'created' });
  }

  return { root, agent, files, notes };
}

/** The terse summary (spec §4.1: structured text, never a JSON blob). */
export function renderInitResult(result: InitResult): string {
  const width = Math.max(...result.files.map((f) => f.status.length));
  const lines = [`diagram init — ${result.root} (agent: ${result.agent})`];
  for (const f of result.files) {
    const status = f.status.padEnd(width);
    lines.push(`  ${status}  ${f.file}${f.reason !== undefined ? ` — ${f.reason}` : ''}`);
  }
  for (const note of result.notes) lines.push(`  ${note}`);
  lines.push('next: run `diagram serve`');
  return `${lines.join('\n')}\n`;
}

/** The `diagram init` command body: install, then print what happened. */
export function initCommand(opts: InitOptions = {}): InitResult {
  const result = runInit(opts);
  process.stdout.write(renderInitResult(result));
  return result;
}

/**
 * Register on the program. The integrator calls this — this module never
 * touches bin/diagram.ts itself (several agents share this repo).
 */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('install the engine into this project (.mcp.json, .gitignore, agent rules, skill)')
    .option('--root <path>', 'project root to install into (default: the current directory) — note this is the project, not .diagram/')
    .option('--agent <name>', 'agent whose MCP config to write: claude | codex | cursor', 'claude')
    .action((opts: { root?: string; agent?: string }) => {
      const agent = opts.agent ?? 'claude';
      if (!isInitAgent(agent)) {
        throw new Error(`--agent must be one of ${INIT_AGENTS.join(', ')}, got "${agent}"`);
      }
      initCommand({
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        agent,
      });
    });
}
