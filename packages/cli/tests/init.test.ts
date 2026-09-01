// tests/init.test.ts — `diagram init` (spec §2.5, §4.1, §4.3, §4.4).
//
// init writes into files a developer already owns, so the two properties under
// test are idempotence and non-destruction. Everything runs against a fresh OS
// temp directory: nothing here may ever write into the repo root, so no test
// calls runInit() without an explicit `dir`.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphPatchSchema, parseDoc } from '../../core/src/index.js';
import { compactRules, loadRules } from '../../core/src/rules/load.js';
import {
  INIT_AGENTS,
  isInitAgent,
  isPluginManaged,
  mcpServerEntry,
  renderInitResult,
  runInit,
  upsertBlock,
  type InitResult,
  type InitStatus,
} from '../src/commands/init.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-init-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function statusOf(result: InitResult, file: string): InitStatus | undefined {
  return result.files.find((f) => f.file === file)?.status;
}

describe('runInit — a fresh project', () => {
  it('writes every file the spec calls for', () => {
    const root = tempProject();
    const result = runInit({ dir: root });

    expect(result.root).toBe(path.resolve(root));
    expect(result.agent).toBe('claude');
    for (const rel of [
      '.mcp.json',
      '.gitignore',
      'CLAUDE.md',
      'AGENTS.md',
      '.claude/skills/diagram/SKILL.md',
      '.diagram/graph.json',
    ]) {
      expect(statusOf(result, rel), rel).toBe('created');
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
  });

  it('writes an MCP server entry that launches THIS engine', () => {
    const root = tempProject();
    runInit({ dir: root });
    const cfg = JSON.parse(read(root, '.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: unknown }>;
    };
    // NOT `npx -y diagram-engine mcp` (the string in spec §4.1): this package
    // is unpublished and that npm name belongs to an unrelated React library
    // with no bin, so following it downloads a stranger's package and then
    // silently fails to start a server. The local binary either works or says
    // "command not found", which is a failure a human can act on.
    expect(cfg.mcpServers['diagram']).toEqual({
      command: 'diagram',
      args: ['mcp'],
    });
    expect(JSON.stringify(cfg)).not.toContain('npx');
  });

  it('ignores the transient files and never graph.json (§2.5)', () => {
    const root = tempProject();
    runInit({ dir: root });
    const gi = read(root, '.gitignore');
    expect(gi).toContain('.diagram/history/');
    expect(gi).toContain('.diagram/errors.txt');
    expect(gi).toContain('.diagram/out.svg');
    // graph.json is committed. The only mention of it must not be an ignore.
    expect(gi.split('\n').some((l) => l.trim() === '.diagram/graph.json')).toBe(false);
    expect(gi).toContain('# diagram-engine:begin');
    expect(gi.trimEnd().endsWith('# diagram-engine:end')).toBe(true);
  });

  it('tells agents to read the rules and to check errors.txt (§4.3, §4.4)', () => {
    const root = tempProject();
    runInit({ dir: root });
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const text = read(root, name);
      expect(text, name).toContain('diagram rules');
      expect(text, name).toContain('.diagram/errors.txt');
      expect(text, name).toContain('.diagram/graph.json');
      expect(text, name).toContain('<!-- diagram-engine:begin');
      expect(text, name).toContain('<!-- diagram-engine:end -->');
    }
  });

  it('installs the skill with frontmatter and the full rules text (§4.4)', () => {
    const root = tempProject();
    runInit({ dir: root });
    const skill = read(root, '.claude/skills/diagram/SKILL.md');
    expect(skill.startsWith('---\n')).toBe(true);
    expect(skill).toContain('name: diagram');
    expect(skill).toContain('description:');
    // The description must say WHEN to use the skill.
    expect(skill).toMatch(/Use whenever/);
    // The canonical rules text, not a paraphrase of it.
    expect(skill).toContain(loadRules().trimEnd());
  });

  it('seeds a schema-valid empty document', () => {
    const root = tempProject();
    runInit({ dir: root });
    const parsed = parseDoc(read(root, '.diagram/graph.json'));
    expect(parsed.ok).toBe(true);
  });
});

describe('runInit — idempotence', () => {
  it('changes nothing on a second run', () => {
    const root = tempProject();
    runInit({ dir: root });

    const rels = [
      '.mcp.json',
      '.gitignore',
      'CLAUDE.md',
      'AGENTS.md',
      '.claude/skills/diagram/SKILL.md',
      '.diagram/graph.json',
    ];
    const before = new Map(rels.map((r) => [r, read(root, r)]));

    const second = runInit({ dir: root });
    for (const rel of rels) {
      expect(statusOf(second, rel), rel).toBe('unchanged');
      expect(read(root, rel), rel).toBe(before.get(rel));
    }
  });

  it('does not duplicate the .gitignore lines or the markdown block', () => {
    const root = tempProject();
    runInit({ dir: root });
    runInit({ dir: root });
    runInit({ dir: root });

    const gi = read(root, '.gitignore');
    expect(gi.split('.diagram/history/').length - 1).toBe(1);
    expect(gi.split('# diagram-engine:begin').length - 1).toBe(1);

    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const text = read(root, name);
      expect(text.split('<!-- diagram-engine:begin').length - 1, name).toBe(1);
      expect(text.split('.diagram/errors.txt').length - 1, name).toBe(1);
    }
  });

  it('does not overwrite an existing diagram', () => {
    const root = tempProject();
    runInit({ dir: root });
    const custom = read(root, '.diagram/graph.json').replace('"Untitled"', '"Kept"');
    expect(custom).toContain('"Kept"'); // guard: the replace must actually bite
    fs.writeFileSync(path.join(root, '.diagram/graph.json'), custom, 'utf8');

    const second = runInit({ dir: root });
    expect(statusOf(second, '.diagram/graph.json')).toBe('unchanged');
    expect(read(root, '.diagram/graph.json')).toBe(custom);
  });
});

describe('runInit — never clobbers', () => {
  it('merges into an .mcp.json holding an unrelated server', () => {
    const root = tempProject();
    const existing = {
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'github-mcp'], env: { TOKEN: 'x' } },
      },
      someOtherKey: { keep: true },
    };
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify(existing, null, 2),
      'utf8',
    );

    const result = runInit({ dir: root });
    expect(statusOf(result, '.mcp.json')).toBe('merged');

    const cfg = JSON.parse(read(root, '.mcp.json')) as Record<string, any>;
    expect(cfg['mcpServers']['github']).toEqual(existing.mcpServers.github);
    expect(cfg['someOtherKey']).toEqual({ keep: true });
    expect(cfg['mcpServers']['diagram']).toEqual(mcpServerEntry('claude'));

    // ...and a second run leaves the neighbours alone.
    const again = runInit({ dir: root });
    expect(statusOf(again, '.mcp.json')).toBe('unchanged');
    const cfg2 = JSON.parse(read(root, '.mcp.json')) as Record<string, any>;
    expect(cfg2).toEqual(cfg);
  });

  it('refuses to touch an unparseable .mcp.json', () => {
    const root = tempProject();
    const junk = '{ this is not json';
    fs.writeFileSync(path.join(root, '.mcp.json'), junk, 'utf8');

    const result = runInit({ dir: root });
    const entry = result.files.find((f) => f.file === '.mcp.json');
    expect(entry?.status).toBe('skipped');
    expect(entry?.reason).toContain('not valid JSON');
    expect(read(root, '.mcp.json')).toBe(junk);
  });

  it('keeps every line of a pre-existing CLAUDE.md and .gitignore', () => {
    const root = tempProject();
    const claude = '# My project\n\nSome house rules the developer wrote.\n';
    const gitignore = 'node_modules\ndist\n';
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), claude, 'utf8');
    fs.writeFileSync(path.join(root, '.gitignore'), gitignore, 'utf8');

    const result = runInit({ dir: root });
    expect(statusOf(result, 'CLAUDE.md')).toBe('updated');
    expect(statusOf(result, '.gitignore')).toBe('updated');

    const nextClaude = read(root, 'CLAUDE.md');
    expect(nextClaude.startsWith(claude)).toBe(true);
    expect(nextClaude).toContain('<!-- diagram-engine:begin');

    const nextGi = read(root, '.gitignore');
    expect(nextGi.startsWith(gitignore)).toBe(true);
    expect(nextGi).toContain('.diagram/out.svg');

    // Second run: still exactly one block, developer content intact.
    runInit({ dir: root });
    expect(read(root, 'CLAUDE.md')).toBe(nextClaude);
    expect(read(root, '.gitignore')).toBe(nextGi);
  });

  it('rewrites a stale block in place rather than appending a new one', () => {
    const root = tempProject();
    runInit({ dir: root });
    const text = read(root, 'CLAUDE.md');
    const damaged = text.replace('## Diagrams', '## Diagrams (old text)');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), damaged, 'utf8');

    const result = runInit({ dir: root });
    expect(statusOf(result, 'CLAUDE.md')).toBe('updated');
    const fixed = read(root, 'CLAUDE.md');
    expect(fixed).toBe(text);
    expect(fixed).not.toContain('(old text)');
  });
});

describe('runInit — per-agent MCP config (Part 11)', () => {
  it('accepts all three agents', () => {
    for (const agent of INIT_AGENTS) {
      expect(isInitAgent(agent)).toBe(true);
    }
    expect(isInitAgent('windsurf')).toBe(false);
  });

  it('gives cursor the ${workspaceFolder} env and its own .cursor/mcp.json', () => {
    const root = tempProject();
    const result = runInit({ dir: root, agent: 'cursor' });
    expect(statusOf(result, '.cursor/mcp.json')).toBe('created');

    for (const rel of ['.mcp.json', '.cursor/mcp.json']) {
      const cfg = JSON.parse(read(root, rel)) as Record<string, any>;
      expect(cfg['mcpServers']['diagram']['env']).toEqual({
        DIAGRAM_DIR: '${workspaceFolder}/.diagram',
      });
    }
  });

  it('omits env for claude and codex, and gives codex the TOML pointer', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const root = tempProject();
      const result = runInit({ dir: root, agent });
      const cfg = JSON.parse(read(root, '.mcp.json')) as Record<string, any>;
      expect(cfg['mcpServers']['diagram']['env'], agent).toBeUndefined();
      expect(result.files.some((f) => f.file === '.cursor/mcp.json'), agent).toBe(false);
      // Every agent gets the "`diagram` must be on PATH" note; codex gets the
      // TOML block to paste as well.
      expect(result.notes.length, agent).toBe(agent === 'codex' ? 2 : 1);
      expect(result.notes.join('\n'), agent).toContain('must be on PATH');
      if (agent === 'codex') {
        expect(result.notes.join('\n')).toContain('[mcp_servers.diagram]');
        expect(result.notes.join('\n')).not.toContain('npx');
      }
    }
  });
});

describe('upsertBlock', () => {
  const B = '<!--b-->';
  const E = '<!--e-->';

  it('creates the block in an empty or missing file', () => {
    expect(upsertBlock(null, 'body', B, E)).toEqual({
      text: `${B}\nbody\n${E}\n`,
      changed: true,
    });
    expect(upsertBlock('   \n', 'body', B, E).changed).toBe(true);
  });

  it('is a no-op when the block already matches', () => {
    const first = upsertBlock(null, 'body', B, E).text;
    expect(upsertBlock(first, 'body', B, E)).toEqual({ text: first, changed: false });
  });

  it('replaces only what is between the markers', () => {
    const original = `head\n\n${B}\nold\n${E}\n\ntail\n`;
    const { text, changed } = upsertBlock(original, 'new', B, E);
    expect(changed).toBe(true);
    expect(text).toBe(`head\n\n${B}\nnew\n${E}\n\ntail\n`);
  });
});

describe('renderInitResult', () => {
  it('is terse structured text ending in the next step', () => {
    const root = tempProject();
    const text = renderInitResult(runInit({ dir: root }));
    expect(text.startsWith('diagram init — ')).toBe(true);
    expect(text).toContain('  created  .mcp.json');
    expect(text.trimEnd().endsWith('next: run `diagram serve`')).toBe(true);
    // No JSON blobs in agent-facing output (§3.1).
    expect(text).not.toContain('{');
  });
});

// ---------------------------------------------------------------------------
// M6 audit fixes.
// ---------------------------------------------------------------------------

/** The first brace-balanced `{"summary"...}` object in a document. */
function firstJsonObject(text: string): string {
  const start = text.indexOf('{"summary"');
  expect(start, 'the file must show a patch example').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced JSON in the example');
}

describe('runInit — the --root option the CLI actually passes', () => {
  it('installs into `root`, and nowhere else', () => {
    const root = tempProject();
    const result = runInit({ root });
    expect(result.root).toBe(path.resolve(root));
    expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(true);
    // Nothing landed in the process's own directory.
    expect(fs.existsSync(path.join(process.cwd(), '.mcp.json'))).toBe(false);
  });

  it('root wins over the deprecated dir alias', () => {
    const wanted = tempProject();
    const other = tempProject();
    const result = runInit({ root: wanted, dir: other });
    expect(result.root).toBe(path.resolve(wanted));
    expect(fs.existsSync(path.join(wanted, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(other, '.mcp.json'))).toBe(false);
  });
});

describe('runInit — the agent instructions actually carry the rules (§4.4)', () => {
  it('writes the rules text into CLAUDE.md and AGENTS.md, not just a pointer', () => {
    const root = tempProject();
    runInit({ root });
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const text = read(root, name);
      // An agent whose whole context is this file, with no MCP server and no
      // reason to shell out, must still see the numbered rules.
      expect(text, name).toContain(compactRules());
      expect(text, name).toContain('DO NOT INVENT');
      expect(text, name).toContain('READ THE DIAGRAM FIRST');
      // ...and the pointer to the full text survives alongside them.
      expect(text, name).toContain('diagram rules');
    }
  });

  it('says how to check a hand edit without assuming `diagram serve` is running', () => {
    const root = tempProject();
    runInit({ root });
    const text = read(root, 'CLAUDE.md');
    expect(text).toContain('diagram check');
    expect(text).toContain('.diagram/errors.txt');
  });

  it('the patch example it prints is a patch the engine actually accepts', () => {
    const root = tempProject();
    runInit({ root });
    for (const name of ['CLAUDE.md', 'AGENTS.md', '.claude/skills/diagram/SKILL.md']) {
      const text = read(root, name);
      const json = firstJsonObject(text);
      const parsed = GraphPatchSchema.safeParse(JSON.parse(json));
      expect(parsed.success, `${name}: ${json}`).toBe(true);
    }
  });

  it('ignores the export target it can actually produce', () => {
    const root = tempProject();
    runInit({ root });
    expect(read(root, '.gitignore')).toContain('.diagram/out.json');
  });
});

describe('runInit — under a plugin install (spec §16.5)', () => {
  it('detects the plugin from CLAUDE_PLUGIN_ROOT', () => {
    expect(isPluginManaged({ CLAUDE_PLUGIN_ROOT: '/somewhere/diagram/1.0.0' })).toBe(true);
    expect(isPluginManaged({})).toBe(false);
    // An empty value is Claude Code NOT setting it, not a plugin at the
    // filesystem root — treating '' as truthy would skip the rules for every
    // ordinary install.
    expect(isPluginManaged({ CLAUDE_PLUGIN_ROOT: '' })).toBe(false);
  });

  it('writes only what is per-project, and says what it skipped', () => {
    const root = tempProject();
    const result = runInit({ dir: root, pluginManaged: true });

    // THE POINT: the plugin ships the rules, so init must not write a second
    // copy. Two copies drift at the next plugin release, and in an
    // architecture with no system prompt the rules text IS the prompt.
    for (const f of ['.mcp.json', 'CLAUDE.md', 'AGENTS.md', '.claude/skills/diagram/SKILL.md']) {
      expect(statusOf(result, f), f).toBe('skipped');
      expect(fs.existsSync(path.join(root, f)), f).toBe(false);
    }

    // What IS per-project still happens.
    expect(statusOf(result, '.gitignore')).toBe('created');
    expect(statusOf(result, '.diagram/graph.json')).toBe('created');
    expect(fs.existsSync(path.join(root, '.diagram', 'graph.json'))).toBe(true);

    // A skipped file always carries a reason (§4.1): four files silently
    // missing is indistinguishable from a broken run.
    for (const f of result.files.filter((x) => x.status === 'skipped')) {
      expect(f.reason, f.file).toBeTruthy();
    }
    expect(result.notes.join('\n')).toContain('plugin install detected');
  });

  it('still writes everything when there is no plugin', () => {
    const root = tempProject();
    const result = runInit({ dir: root, pluginManaged: false });
    for (const f of ['.mcp.json', 'CLAUDE.md', 'AGENTS.md', '.claude/skills/diagram/SKILL.md']) {
      expect(statusOf(result, f), f).not.toBe('skipped');
      expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    }
  });
});
