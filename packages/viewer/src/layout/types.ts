// layout/types.ts — shared types for the layout modules (spec §5).
//
// Geometry lives only in memory on the viewer side. Nothing in this
// module (or any layout module) is ever written back to the document
// (spec §1.4 / §3.1).

/** A measured box, in px. Input to ELK; never persisted. */
export interface Size {
  width: number;
  height: number;
}
