// layout/options.ts — ELK layout options (spec §5.2).
//
// Three options carry the weight:
// - 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' — without it ELK lays
//   out each container independently and cross-boundary edges route
//   badly or not at all.
// - 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' —
//   ELK breaks ties using input array order; with stable IDs and
//   append-only patches this keeps turn 6 looking like turn 5 (G4).
// - 'elk.spacing.edgeEdge': '18' — hop arcs have radius 6, so
//   parallel edges need ~16px of separation or the arcs collide.

import type { LayoutOptions } from 'elkjs';
import type { Direction } from '@diagram-engine/core';

/**
 * Root layout options (spec §5.2). 'elk.direction' comes from
 * doc.direction, so this is a builder rather than a constant.
 */
export const ROOT_OPTIONS = (direction: Direction): LayoutOptions => ({
  'elk.algorithm': 'layered',
  'elk.direction': direction,
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.spacing.nodeNode': '44',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.layered.spacing.edgeNodeBetweenLayers': '28',
  'elk.spacing.edgeEdge': '18',
  'elk.spacing.edgeNode': '20',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.mergeEdges': 'false',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]',
});

/** Per-group (container) options (spec §5.2). top=44 = room for the label. */
export const GROUP_OPTIONS: LayoutOptions = {
  'elk.padding': '[top=44,left=20,bottom=20,right=20]',
  'elk.spacing.nodeNode': '36',
};
