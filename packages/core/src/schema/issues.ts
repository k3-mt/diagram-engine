// schema/issues.ts — turn zod issues into the agent-facing error lines
// the agent self-corrects from (spec §3.3).
//
// Every message the agent sees has to say WHAT is wrong and WHAT TO DO.
// Zod mostly gives us that, because each schema carries a remediation
// message — except for issues that NEST: a record whose KEY schema
// rejects the key reports a parent issue reading "Invalid key in record"
// and hides the useful message in issue.issues[]. Naively mapping only
// the top level produced
//
//   nodes.0.meta.BAD: Invalid key in record
//
// which tells the agent nothing about how to write a valid key. This
// module flattens those nested issues, joining the parent's path with the
// child's, so the same input now reports
//
//   nodes.0.meta.BAD: use a lowercase key of 1-24 chars, ...
//
// The same nesting happens for unions and for element-level failures, so
// the flatten is generic rather than a special case for meta.

import type { z } from 'zod/v4';

/** A zod issue, possibly carrying nested issues of its own. */
type Issue = z.core.$ZodIssue & { issues?: readonly z.core.$ZodIssue[] };

/** "nodes.0.meta.BAD", or "(root)" when the issue is on the document. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((p) => String(p)).join('.') || '(root)';
}

/**
 * One "path: message" line per issue, with nested issues (invalid record
 * keys, union branches) replaced by the messages they hide, which are the
 * ones that say what to do. Order is preserved.
 */
export function formatIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: ReadonlyArray<PropertyKey> = [],
): string[] {
  const out: string[] = [];
  for (const raw of issues) {
    const issue = raw as Issue;
    const path = [...prefix, ...(issue.path ?? [])];
    const nested = issue.issues;
    if (nested !== undefined && nested.length > 0) {
      out.push(...formatIssues(nested, path));
      continue;
    }
    out.push(`${formatPath(path)}: ${issue.message}`);
  }
  return out;
}
