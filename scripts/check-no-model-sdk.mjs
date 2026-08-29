#!/usr/bin/env node
// CI guard (spec §1.3 / §2.3): this project ships NO model SDKs, no API-key
// tooling, no HTTP clients to model providers. Fail the build if any
// package.json in the repo declares one.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Patterns matched against dependency NAMES (lowercased).
// Note: '@modelcontextprotocol/sdk' is allowed — MCP is the tool-interop
// standard, not a model SDK.
const BANNED = [
  /^openai$/,
  /^@openai\//,
  /^@anthropic-ai\//,
  /^anthropic$/,
  /^@google\/generative/,
  /^@google\/genai$/,
  /^@google-ai\//,
  /^google-generativeai$/,
  /^@aws-sdk\/client-bedrock/,
  /^@azure\/openai$/,
  /^@mistralai\//,
  /^mistralai$/,
  /^cohere-ai$/,
  /^@cohere-ai\//,
  /^groq-sdk$/,
  /^together-ai$/,
  /^replicate$/,
  /^@huggingface\/inference$/,
  /^ollama$/,
  /^@langchain\//,
  /^langchain$/,
  /^llamaindex$/,
  /^ai$/,                 // Vercel AI SDK
  /^@ai-sdk\//,
  /^dotenv$/,
  /^dotenv-/
];

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundledDependencies'
];

function findPackageJsons(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findPackageJsons(full, out);
    else if (entry === 'package.json') out.push(full);
  }
  return out;
}

const violations = [];

for (const file of findPackageJsons(ROOT)) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue; // unparseable package.json is not this guard's problem
  }
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    const names = Array.isArray(deps) ? deps : Object.keys(deps);
    for (const name of names) {
      if (BANNED.some((re) => re.test(String(name).toLowerCase()))) {
        violations.push(
          `${relative(ROOT, file)}: ${field} lists banned package "${name}"`
        );
      }
    }
  }
}

if (violations.length) {
  console.error('check:no-model-sdk FAILED — model SDKs are banned (spec §1.3):');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log('check:no-model-sdk OK — no model SDK, no dotenv, anywhere.');
