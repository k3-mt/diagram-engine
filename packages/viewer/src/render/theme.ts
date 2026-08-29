// render/theme.ts — the product theme (spec §8.2), verbatim.
//
// Type colour appears ONLY as a 3px left border and in the icon.
// Never fill the whole box — at 30 nodes it becomes a carnival.

import type { NodeType } from '@diagram-engine/core';

export const theme = {
  canvas: '#FBFBF9',
  node:   { fill: '#FFFFFF', stroke: '#D4D2CC', radius: 8,
            shadow: '0 1px 2px rgba(0,0,0,.06)' },
  text:   { primary: '#1F1E1C', secondary: '#77756E' },
  edge:   { stroke: '#8A8880', width: 1.5 },
  group:  { fill: 'rgba(0,0,0,.018)', stroke: '#C9C7C0', dash: '4 4', radius: 12 },
  // ERD addition: `entity` is a slate-teal — the same muted mid-tone
  // family as the seven §8.2 accents, sitting between the service blue
  // (#3B6FD4) and the database green (#2E8B69) so a table reads as
  // "data, but not a deployed store". Every other value here is §8.2
  // verbatim and must stay so.
  accent: { service:'#3B6FD4', database:'#2E8B69', queue:'#C4791E',
            cache:'#B8452F', storage:'#6B5BA8', client:'#4A4845',
            external:'#8A8880', entity:'#2F7A8C' }
};

// Compile-time completeness check: every NodeType has an accent colour.
// (Assignment fails to compile if the schema enum and the theme drift.)
const accentCoversEveryNodeType: Record<NodeType, string> = theme.accent;
void accentCoversEveryNodeType;
