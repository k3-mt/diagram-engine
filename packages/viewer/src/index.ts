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
export {
  ACCENT_W,
  BADGE_FONT,
  ENTITY,
  ENTITY_FIELD_FONT,
  LABEL_FONT,
  NODE,
  badgeClusterWidth,
  badgeWidth,
  clamp,
  fieldBadges,
  fieldRowWidth,
  measureText,
  sizeNode,
} from './layout/measure.js';
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
  composeFramePaths,
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
export {
  Canvas,
  FrameLayers,
  CROSSFADE_MS,
  HOVER_RING_PAD,
  HOVER_RING_W,
  type CanvasProps,
  type HoverProps,
} from './render/Canvas.js';
export {
  EdgeLabel,
  EdgePath,
  ArrowMarker,
  ARROW_MARKER_ID,
  EDGE_DASH,
  // ERD: crow's-foot markers and the cardinality → marker mapping.
  CrowManyMarker,
  CrowOneMarker,
  MANY_MARKER_ID,
  ONE_MARKER_ID,
  cardinalityMarkers,
} from './render/EdgePath.js';
export { GroupLabel, GroupRect, GROUP_LABEL_FONT } from './render/GroupRect.js';
export {
  NodeBox,
  NodeContent,
  NOTE_FONT,
  accentPath,
  labelWidth,
  truncateToWidth,
  type HoverHandlers,
  type NodeBoxProps,
} from './render/NodeBox.js';
// ERD: an `entity` node with fields, drawn as a table (capability A).
export {
  EntityBox,
  EntityContent,
  BADGE_FILL,
  BADGE_H,
  isEntityTable,
  rowCenterY,
  visibleRowCount,
} from './render/EntityBox.js';
// Node metadata inspection panel (capability B). Pure markup + placement
// math — read-only, and never a mutation path (§1.6).
export {
  HoverCard,
  CARD_MARGIN,
  CARD_OFFSET,
  CARD_W,
  cardHeight,
  placeCard,
  type CardPlacement,
  type HoverCardProps,
} from './render/HoverCard.js';
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
  // Drag panning (capability C): plain left-drag and space-drag share this
  // pure state machine. Viewport control only — it never patches (§1.6/§7).
  PAN_THRESHOLD_PX,
  advanceDrag,
  beginDrag,
  dragDistance,
  dragPan,
  endDrag,
  panCursor,
  type Bounds,
  type DragMode,
  type DragState,
  type UseViewportResult,
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
