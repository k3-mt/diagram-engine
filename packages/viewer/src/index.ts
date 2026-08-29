// @diagram-engine/viewer — package entry.
//
// Re-exports the M2 layout pipeline and the M3 geometry pipeline.
// Everything here is a pure function usable from Node (vitest); DOM
// access only happens behind explicit feature checks with deterministic
// fallbacks (measure.ts, worker.ts). Geometry is derived per frame and
// NEVER persisted to the document (spec §1.4/§3.1).
//
// The browser app entry is main.tsx (mounted by index.html), not this
// module; the worker entry is layout/worker.ts.

export const VIEWER_PACKAGE = '@diagram-engine/viewer';

// --- M2 layout (spec §5) ---------------------------------------------------
export { layout, layoutElkGraph } from './layout/runLayout.js';
export { ELK_ROOT_ID, toElk } from './layout/toElk.js';
export {
  flatten,
  type AbsEdge,
  type AbsEdgeLabel,
  type AbsPoint,
  type LaidOut,
  type Rect,
} from './layout/fromElk.js';
export { LABEL_FONT, NODE, clamp, measureText, sizeNode } from './layout/measure.js';
export { GROUP_OPTIONS, ROOT_OPTIONS } from './layout/options.js';
export type { Size } from './layout/types.js';
export {
  LayoutClient,
  handleLayoutRequest,
  type LayoutRequest,
  type LayoutResponse,
  type WorkerLike,
} from './layout/worker.js';

// --- M3 geometry (spec §6) -------------------------------------------------
export {
  composePath,
  toSegments,
  findCrossings,
  pointNear,
  buildHopSpans,
  mergeClusters,
  segKey,
  buildPath,
  buildPathCmds,
  serializePath,
  roundCorners,
  HOP_R,
  CORNER_GUARD,
  NODE_GUARD,
  CORNER_R,
  MIN_ROUND_SEG,
  HOP_CLEARANCE,
  type Crossing,
  type PathCmd,
  type Point,
  type Seg,
  type Span,
} from './geometry';

// --- M4 renderer (spec §8) -------------------------------------------------
// Everything here is React + pure math. layout/elkBrowser.ts and main.tsx are
// deliberately NOT re-exported: they are browser-only (vite `?worker` syntax /
// DOM mount) and would break any Node consumer, vitest included.
export { Canvas, FrameLayers, CROSSFADE_MS, type CanvasProps } from './render/Canvas.js';
export { EdgeLabel, EdgePath, ArrowMarker, ARROW_MARKER_ID, EDGE_DASH } from './render/EdgePath.js';
export { GroupLabel, GroupRect, GROUP_LABEL_FONT } from './render/GroupRect.js';
export { NodeBox, NodeContent, labelWidth, truncateToWidth } from './render/NodeBox.js';
export { ICON_SIZE, NODE_ICONS } from './render/icons.js';
export { theme } from './render/theme.js';
export {
  StatusBar,
  BAR_HEIGHT,
  CONNECTION_COLOR,
  CONNECTION_LABEL,
  countsText,
  lastUpdateText,
  useElapsed,
  useFlash,
  docErrorText,
  ERROR_COLOR,
  FLASH_MS,
  type DocError,
  type StatusBarProps,
  type StatusCounts,
} from './render/StatusBar.js';
export {
  useViewport,
  fitToContent,
  clampScale,
  panBy,
  wheelZoomFactor,
  zoomAt,
  viewportTransform,
  boundsEqual,
  FIT_ANIMATION_MS,
  FIT_PAD,
  MAX_FIT_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  type Bounds,
  type Viewport,
} from './render/viewport.js';

// --- M5 live document feed (spec §9) ---------------------------------------
export {
  connectViewer,
  defaultWsUrl,
  parseDocMessage,
  parseServerMessage,
  DOWN_AFTER_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  type ConnectionState,
  type ServerFrame,
  type ViewerSocket,
  type ViewerSocketOptions,
} from './ws.js';

// --- Debug renderer frame (M2 step 9 / M3 exit) ----------------------------
export {
  buildFrame,
  type DebugEdge,
  type DebugFrame,
  type DebugGroup,
  type DebugNode,
} from './debug/frame.js';
