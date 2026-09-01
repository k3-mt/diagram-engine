// scripts/build-plugin.mjs — assemble the Claude Code plugin (spec §16.4).
//
// Produces a directory that is a pure FILE FETCH to install: no package.json,
// no lockfile, no install step, no build. That is the §16.2 requirement, and
// it is enforced here rather than trusted — see the guard at the end, which
// fails the build if a manifest or lockfile has crept in. "We ship no
// package.json" is the kind of property that decays silently: a stray file
// copied in by a later change puts package-manager execution back on every
// developer's machine, which is exactly the risk this shape exists to remove.
//
// Layout (§16.4):
//   .claude-plugin/plugin.json       name, version — bump on every release
//   .claude-plugin/marketplace.json  the repo is its own marketplace
//   .mcp.json                        node ${CLAUDE_PLUGIN_ROOT}/dist/bin/...
//   skills/diagram/SKILL.md          rules.md, verbatim
//   commands/diagram-serve.md        starts the viewer
//   dist/                            prebuilt AND bundled
//
// Run `npm run build` first: this copies packages/cli/dist, it does not
// produce it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'plugin');
const distSrc = path.join(repo, 'packages', 'cli', 'dist');

if (!fs.existsSync(path.join(distSrc, 'bin', 'diagram-mcp.mjs'))) {
  process.stderr.write('build-plugin: packages/cli/dist is not built — run `npm run build`\n');
  process.exit(1);
}

// The version the plugin reports. Single source: the CLI's package.json, so
// `diagram --version` and the marketplace entry can never disagree (§16.7).
const cliPkg = JSON.parse(
  fs.readFileSync(path.join(repo, 'packages', 'cli', 'package.json'), 'utf8'),
);
const version = cliPkg.version;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, '.claude-plugin'), { recursive: true });

const write = (rel, text) => {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};

write('.claude-plugin/plugin.json', JSON.stringify({
  name: 'diagram',
  version,
  description:
    'Turn prose into architecture diagrams, drawn by the agent you are already running. ' +
    'No API keys, no model in the engine.',
  author: { name: 'diagram-engine' },
  keywords: ['architecture', 'diagram', 'erd', 'documentation'],
}, null, 2) + '\n');

// The marketplace manifest lives at the REPOSITORY root, not in plugin/,
// because that is where `claude plugin marketplace add <owner>/<repo>` looks.
// Keeping it there means the engine repo IS its own marketplace (§16.4) and no
// second repository has to be kept in sync — the plugin is a subdirectory the
// entry points at.
//
// This does not weaken §16.2. The repo root has a package.json and a lockfile,
// but the PLUGIN root (plugin/) has neither, and that is the directory whose
// contents get fetched and whose auto-install path must stay unreachable.
const marketplace = JSON.stringify({
  name: 'diagram-engine',
  owner: { name: 'k3-mt' },
  description: 'The diagram engine, distributed as a Claude Code plugin.',
  plugins: [{
    name: 'diagram',
    source: './plugin',
    description: 'Prompt-driven architecture diagrams, rendered live in your browser.',
    version,
  }],
}, null, 2) + '\n';
fs.mkdirSync(path.join(repo, '.claude-plugin'), { recursive: true });
fs.writeFileSync(path.join(repo, '.claude-plugin', 'marketplace.json'), marketplace, 'utf8');

// ${CLAUDE_PLUGIN_ROOT} is the pivot the whole no-npm approach turns on
// (§16.4). It is expanded in `command`, `args` AND `env`, and Claude Code
// also exports it into the server's environment — which is what
// `diagram init` reads to know it must not write a second copy of the rules
// (§16.5, isPluginManaged).
write('.mcp.json', JSON.stringify({
  mcpServers: {
    diagram: {
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/bin/diagram-mcp.mjs'],
    },
  },
}, null, 2) + '\n');

// The skill is rules.md verbatim (§4.4): in an architecture with no system
// prompt, that text IS the prompt, so it is copied rather than paraphrased.
const rules = fs.readFileSync(path.join(repo, 'packages', 'core', 'rules.md'), 'utf8');
write('skills/diagram/SKILL.md', [
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
  rules,
].join('\n'));

// Path B (the `bin/` convention that puts `diagram` on PATH) does not come
// along with a marketplace install (§16.5). Without this command the first
// run is "the tools work, the agent says it added four nodes, and nothing
// appears on screen" — indistinguishable from broken. So the one CLI
// invocation that matters is shipped as a slash command.
write('commands/diagram-serve.md', `---
description: Open the live diagram viewer in your browser
allowed-tools: Bash(node:*)
---

Start the diagram viewer, which watches \`.diagram/graph.json\` and repaints
the browser whenever the diagram changes.

Run this, and report the URL it prints:

\`\`\`
node "\${CLAUDE_PLUGIN_ROOT}/dist/bin/diagram.mjs" serve
\`\`\`

It stays running and serves on http://localhost:4400 (auto-incrementing if
that port is taken). It binds to 127.0.0.1 only.
`);

/** Copy a directory tree. */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Only the two bundles and the viewer's static assets ship. The tsc output
// under dist/cli, dist/core and dist/viewer is an intermediate: it still
// resolves imports from node_modules, so shipping it would put a broken
// second copy of the engine next to the working one.
fs.mkdirSync(path.join(out, 'dist', 'bin'), { recursive: true });
for (const name of ['diagram.mjs', 'diagram-mcp.mjs']) {
  fs.copyFileSync(path.join(distSrc, 'bin', name), path.join(out, 'dist', 'bin', name));
  fs.chmodSync(path.join(out, 'dist', 'bin', name), 0o755);
}
copyDir(path.join(distSrc, 'public'), path.join(out, 'dist', 'public'));

// THE GUARD (§16.2). A plugin shipping a package.json WITH a lockfile gets
// its dependencies auto-installed into a cache directory — convenient in
// general and exactly wrong here. Make the auto-install path unreachable
// rather than merely unused, and prove it on every build.
const forbidden = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
const found = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (forbidden.includes(e.name)) found.push(path.relative(out, p));
  }
})(out);
if (found.length > 0) {
  process.stderr.write(
    'build-plugin FAILED (spec §16.2): the plugin must ship no manifest and no lockfile.\n' +
    found.map((f) => '  ' + f).join('\n') + '\n',
  );
  process.exit(1);
}

const bytes = [];
(function measure(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) measure(p);
    else bytes.push(fs.statSync(p).size);
  }
})(out);
process.stdout.write(
  `plugin: ${out}\n` +
  `  ${bytes.length} files, ${(bytes.reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(1)} MB\n` +
  `  no package.json, no lockfile — install is a pure file fetch\n`,
);
