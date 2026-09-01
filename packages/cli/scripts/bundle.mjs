// Build step 3 of 3 (see tsconfig.build.json): bundle each binary into a
// single self-contained file at dist/bin/<name>.js.
//
// WHY THIS EXISTS (spec §16.2). `tsc` COMPILES but does not BUNDLE: the
// emitted dist/cli/src/bin/*.js still resolve `zod`, `elkjs`, the MCP SDK and
// `commander` from node_modules at runtime. That is fine when the engine is
// installed by a package manager, and fatal for plugin distribution, where the
// whole point is that the plugin root carries NO package.json and NO lockfile
// so the auto-install path is unreachable rather than merely unused. A user
// then runs an artifact that was built and audited once, and never a package
// manager. Bundling is what makes that shape possible at all.
//
// This replaces emit-bin-shim.mjs. The shim existed because tsc's output path
// (dist/cli/src/bin/x.js) is not the stable path package.json's "bin" points
// at (dist/bin/x.js); esbuild simply writes the stable path directly.
//
// NOTE the entry points are the COMPILED .js, not the .ts sources. tsc has
// already type-checked and emitted; esbuild only has to follow imports and
// inline them, so it never needs a TS config of its own and can never disagree
// with tsc about what the types mean.
//
// Node built-ins are external by definition. Nothing else is: if a dependency
// cannot be inlined, that is a build failure worth seeing, not something to
// paper over with an --external flag.
//
// THE OUTPUT IS .mjs, NOT .js, AND THAT IS LOad-BEARING. Node decides whether
// a .js file is ESM or CommonJS by looking up the directory tree for a
// package.json with "type": "module". The plugin artifact deliberately has no
// package.json anywhere (§16.2), so a .js bundle there is parsed as CommonJS,
// and an ESM bundle then dies on its own first `import` — or, more confusingly,
// on the shebang. The .mjs extension states the format in the filename, which
// is the only channel left once the manifest is gone.

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(pkgRoot, 'dist', 'bin');

const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const names = Object.keys(pkg.bin ?? {});
if (names.length === 0) {
  process.stderr.write('bundle: package.json declares no "bin" entries\n');
  process.exit(1);
}

// Clear dist/bin before writing. A previous build under a different
// extension leaves an executable file behind that nothing regenerates and
// nothing overwrites — and an `npm link` symlink or a plugin's .mcp.json
// still pointing at it gets a bundle that LOOKS fine and dies on load. That
// happened once, during the .js -> .mjs move, and cost real debugging time
// on a "broken" MCP server that was in fact a stale artifact.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const name of names) {
  const entry = path.join(pkgRoot, 'dist', 'cli', 'src', 'bin', `${name}.js`);
  if (!fs.existsSync(entry)) {
    process.stderr.write(`bundle: ${entry} missing — did tsc run?\n`);
    process.exit(1);
  }
  const outfile = path.join(outDir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    // No shebang banner: esbuild carries the one already at the top of the
    // .ts entry point through to the bundle, and a second copy is a syntax
    // error on line 2 rather than a harmless duplicate.
    //
    // What the banner IS for: `commander` and parts of the MCP SDK are
    // CommonJS. Inlining them into an ESM bundle leaves calls to esbuild's
    // __require shim, which throws "Dynamic require of node:events is not
    // supported" — the shim only forwards to a real `require` if one is in
    // scope, and in an ES module there is none. createRequire supplies it.
    // Safe next to the shebang: esbuild hoists the preserved shebang above
    // the banner, so this lands on line 2 where it is ordinary code.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';\n" +
          'const require = __createRequire(import.meta.url);',
    },
    //
    // Each entry point asks "was I executed directly?" by testing whether
    // process.argv[1] ends in its own name (see bin/diagram-mcp.ts, whose
    // regex accepts .mjs). Writing the bundle to dist/bin/<name>.mjs keeps
    // that true, which is why the output path matters beyond tidiness.
    // import.meta.url is used to locate dist/public and dist/bin/diagram.js at
    // runtime. Keeping the ESM format means it stays meaningful; a CJS bundle
    // would have to shim it and would resolve to the wrong directory.
    external: [],
    logLevel: 'warning',
    metafile: true,
  }).then((r) => {
    const bytes = r.metafile.outputs[path.relative(process.cwd(), outfile)]?.bytes;
    process.stdout.write(
      `bundle: ${name} -> dist/bin/${name}.mjs` +
      (bytes ? ` (${(bytes / 1024).toFixed(0)} kB)` : '') + '\n',
    );
  });
  fs.chmodSync(outfile, 0o755);
}
