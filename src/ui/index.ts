// Layer 3 — the ergonomic API.
//
//   import { Application, Window, VStack, Label, Button } from "./src/ui/index.ts";
//
// Anything not covered here drops through to Layer 2: every wrapper exposes
// `.native`, and `objc.AnyClass` reaches the whole of AppKit.

export * from "./appkit.ts";
export * from "./view.ts";
export * from "./layout.ts";
export * from "./controls.ts";
export * from "./window.ts";
export * from "./menu.ts";
export * from "./table.ts";
export * from "./dialogs.ts";
export * from "./input.ts";
export * from "./app.ts";
export * from "./snapshot.ts";
export * from "./chrome.ts";

// Metal. Scene3D is a View, so it belongs with the rest of the layout classes.
export * from "../metal/index.ts";

// The escape hatch, re-exported so an app only needs one import.
export {
  objc,
  tryClass,
  createDelegate,
  createBlock,
  cfunction,
  globalObject,
  globalDouble,
  symbolAddress,
  nsstring,
  str,
  toJS,
  wrap,
  withPool,
  stats,
  ObjCObject,
  ObjCClass,
  ObjCBlock,
} from "../objc.ts";

export { Rect, Point, Size, Range, Insets } from "../structs.ts";
export type { CGRect, CGPoint, CGSize, NSRange, NSEdgeInsets } from "../structs.ts";
