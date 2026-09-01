// view/presets.ts — the three view presets (spec Part 7).
//
// A preset answers exactly one question: which group ids belong in
// doc.collapsed? Nothing else. The collapse-and-merge pass that turns a
// document plus that list into a drawable view is deriveView, in the
// sibling module; keeping the resolver separate means `diagram view exec` is a
// pure list computation the CLI, the MCP tool and the viewer's status-bar
// buttons all share.
//
//   exec        the shallowest level holding more than one group — the
//               boardroom view. Usually the root groups; on a diagram wrapped
//               in one outer container, the level inside it (view/depth.ts)
//   eng         [] — nothing collapsed, everything open
//   focus <id>  every group id EXCEPT <id> and its ancestors, so the chain
//               down to the focused group stays open and the rest shuts
//
// Errors follow the V1–V13 convention from document/validate.ts: say what is
// wrong, then say what to do, then list the valid ids. The agent reads the
// message and corrects itself on the same turn instead of calling back for a
// listing it was just handed.

import type { GraphDoc } from '../schema/graph.js';
import { collapsedAtDepth, execDepth } from './depth.js';

/** The preset names, in the order the CLI and the viewer's buttons show them. */
export const VIEW_PRESET_NAMES = ['exec', 'eng', 'focus'] as const;

/** A preset name on its own — `focus` still needs an id to be resolvable. */
export type ViewPresetName = (typeof VIEW_PRESET_NAMES)[number];

/**
 * A fully specified preset: the name plus, for `focus`, the group it centres
 * on. Written as a discriminated union so a `focus` without an id cannot be
 * constructed and every caller is forced to supply one.
 */
export type ViewPreset =
  | { preset: 'exec' }
  | { preset: 'eng' }
  | { preset: 'focus'; id: string };

/** Resolution result: the collapsed list, or the messages telling the caller why not. */
export type PresetResult =
  | { ok: true; collapsed: string[] }
  | { ok: false; errors: string[] };

/** Result of parsing a preset out of raw CLI/tool arguments. */
export type ParsedPreset =
  | { ok: true; preset: ViewPreset }
  | { ok: false; errors: string[] };

/** True when `name` is one of the three preset names. */
export function isViewPresetName(name: string): name is ViewPresetName {
  return (VIEW_PRESET_NAMES as readonly string[]).includes(name);
}

/**
 * Build a ViewPreset from the raw strings a CLI argument or an MCP tool input
 * hands over (`diagram view focus vpc-private` -> name "focus", id
 * "vpc-private"). Validates the name and the presence of the focus id; the id
 * itself is checked against the document by resolvePreset.
 */
export function parseViewPreset(name: string, id?: string): ParsedPreset {
  if (!isViewPresetName(name)) {
    return {
      ok: false,
      errors: [
        `unknown preset "${name}": use one of ${VIEW_PRESET_NAMES.join(', ')}`,
      ],
    };
  }
  if (name === 'focus') {
    if (id === undefined || id === '') {
      return {
        ok: false,
        errors: ['preset "focus" needs a group id: diagram view focus <group-id>'],
      };
    }
    return { ok: true, preset: { preset: 'focus', id } };
  }
  if (id !== undefined && id !== '') {
    // `diagram view exec region-eu` is one word away from
    // `diagram view focus region-eu` and means close to the OPPOSITE — exec
    // collapses that boundary, focus is the only preset that opens it. Left
    // unchecked the id is simply dropped and the command reports a plain
    // success, so the agent believes it opened the group it just closed.
    return {
      ok: false,
      errors: [
        `preset "${name}" takes no id, and "${id}" was ignored.`,
        `did you mean \`diagram view focus ${id}\`? "${name}" collapses by rule, not by target.`,
      ],
    };
  }
  return { ok: true, preset: { preset: name } };
}

/**
 * Ancestors of `id`, nearest first: its parent, its parent's parent, and so
 * on. Nodes and groups share one id namespace and both carry `parent`, so the
 * walk works from either. A malformed document (a parent cycle — V4 rejects
 * it, but this module never assumes it ran) terminates on the seen set rather
 * than spinning.
 */
function ancestorsOf(doc: GraphDoc, id: string): string[] {
  const parentOf = new Map<string, string | null>();
  for (const n of doc.nodes) parentOf.set(n.id, n.parent);
  for (const g of doc.groups) parentOf.set(g.id, g.parent);

  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = parentOf.get(id) ?? null;
  while (cur !== null && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return out;
}

/**
 * `Existing groups: a, b` — or the "there are none" form when the doc has no
 * groups.
 *
 * Exported because every surface that has to say "that group id is not one of
 * ours" needs exactly this sentence: the preset errors below, `diagram view`,
 * and the diagram_view tool's explicit-collapsed-list check. One wording, in
 * one place, so an agent that learns to read it once can read it everywhere.
 */
export function existingGroupsLine(doc: GraphDoc): string {
  const ids = doc.groups.map((g) => g.id);
  if (ids.length === 0) {
    return 'This diagram has no groups: use preset "eng" to show everything';
  }
  return `Existing groups: ${ids.join(', ')}`;
}

/** The same sentence appended to an error, hence the leading space. */
function groupsSuffix(doc: GraphDoc): string {
  return ` ${existingGroupsLine(doc)}`;
}

/**
 * Resolve a preset to the group ids that belong in doc.collapsed (spec Part 7).
 *
 * Never throws: an unknown focus id, or a focus id naming a node instead of a
 * group, comes back as `{ ok: false, errors }` in the same voice as the
 * validation errors, so the CLI can print it to stderr and the MCP tool can
 * return it as its result without either surface inventing its own wording.
 */
export function resolvePreset(doc: GraphDoc, preset: ViewPreset): PresetResult {
  const groupIds = doc.groups.map((g) => g.id);

  switch (preset.preset) {
    case 'eng':
      // Everything open: the engineer wants the whole graph, not a summary.
      return { ok: true, collapsed: [] };

    case 'exec':
      // The outermost level that actually DIVIDES the system, shut, so the
      // diagram reads as N boxes. That is depth 0 on a document whose top
      // level holds several boundaries — the old rule, unchanged — but on a
      // document wrapped in a single outer container it is the level below it,
      // because collapsing a lone wrapper summarises nothing. execDepth makes
      // that choice; see view/depth.ts.
      return { ok: true, collapsed: collapsedAtDepth(doc, execDepth(doc)) };

    case 'focus': {
      const { id } = preset;
      if (!groupIds.includes(id)) {
        const node = doc.nodes.find((n) => n.id === id);
        if (node !== undefined) {
          // Naming a node is the likely mistake: focus opens a container, and
          // a node contains nothing. Point at the group that holds it.
          const parent =
            node.parent !== null
              ? ` Did you mean its group "${node.parent}"?`
              : ' It sits at the top level, so there is nothing to focus.';
          return {
            ok: false,
            errors: [
              `focus target "${id}" is a node, not a group: focus takes a group id.${parent}`,
            ],
          };
        }
        return {
          ok: false,
          errors: [`unknown focus group "${id}".${groupsSuffix(doc)}`],
        };
      }
      const open = new Set<string>([id, ...ancestorsOf(doc, id)]);
      return { ok: true, collapsed: groupIds.filter((g) => !open.has(g)) };
    }
  }
}
