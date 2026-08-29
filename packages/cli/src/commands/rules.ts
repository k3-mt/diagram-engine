// commands/rules.ts — `diagram rules` (spec §4.4; M6 Step 15).
//
// Prints the canonical agent rules to stdout, verbatim. There is no system
// prompt in this architecture, so this text IS the prompt: an agent that cannot
// reach the MCP tool descriptions can still run one shell command and learn how
// to drive the engine, and `diagram init` pipes the same text into CLAUDE.md.
//
// Two documents, kept separate on purpose (a decision made for M6): the core
// rules and the ERD addendum. An agent drawing an architecture diagram should
// not pay for the tables-and-foreign-keys instructions it will never use, so
// `--erd` selects rules-erd.md instead of appending it.
//
// A passthrough and nothing more — no headers, no wrapping, no "here are the
// rules:" preamble. Whatever this prints is what the agent reads as its
// instructions, and text the engine added around them is text the agent has to
// work out is not an instruction.
//
// Runtime import of core by relative path — see commands/get.ts for why. The
// loader embeds the rules text and touches no files, so this works identically
// from src/ under vitest and from dist/ after a build (see core/src/rules/load.ts).
//
// This is the one command that does not go through emit(): emit appends a
// newline, and the rules text already ends in one — `diagram rules > CLAUDE.md`
// should produce the file byte-for-byte, not with a blank line bolted on.

import type { Command } from 'commander';
import { loadRulesFor, type RulesVariant } from '../../../core/src/index.js';
import { ok, type CommandResult } from './context.js';

export interface RulesOptions {
  /** Print rules-erd.md instead of rules.md. */
  erd?: boolean;
}

/** The rules text for the requested variant. Never fails: the text is compiled in. */
export function runRules(opts: RulesOptions = {}): CommandResult {
  const variant: RulesVariant = opts.erd === true ? 'erd' : 'core';
  return ok(loadRulesFor(variant));
}

/**
 * The command body. The text is written as-is with exactly one trailing
 * newline, so `diagram rules > CLAUDE.md` and `diagram rules | head` both
 * behave the way a shell user expects.
 */
export function rulesCommand(opts: RulesOptions = {}): CommandResult {
  const result = runRules(opts);
  process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
  return result;
}

/** Register `diagram rules` on the program. Called by bin/diagram.ts (M6 integration). */
export function registerRules(program: Command): void {
  program
    .command('rules')
    .description('print the agent rules for building diagrams')
    .option('--erd', 'print the ERD (entity-relationship) rules instead')
    .action((opts: { erd?: boolean }) => {
      rulesCommand({ ...(opts.erd !== undefined ? { erd: opts.erd } : {}) });
    });
}
