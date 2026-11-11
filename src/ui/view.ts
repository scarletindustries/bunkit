// The View base class — everything visible in Layer 3 is one of these.
//
// A View is a thin, stateful wrapper over an NSView. It deliberately does not
// diff or reconcile: AppKit views are retained, stateful objects and treating
// them like a virtual DOM is a category error. You mutate properties; the view
// updates.

import { objc, createDelegate, nativeOf, ObjCObject } from "../objc.ts";
import { LayoutAttribute, LayoutPriority, LayoutRelation, Orientation } from "./appkit.ts";
import type { CGRect, CGSize } from "../structs.ts";

let actionCounter = 0;

/**
 * A target/action pair. AppKit controls need an Obj-C object with a selector,
 * so we mint a tiny runtime class per handler; all of them share one Obj-C
 * class because createDelegate caches by *shape*.
 */
export function actionTarget(fn: (sender: any) => void): ObjCObject {
  return createDelegate(
    { "brAction:": (sender: any) => fn(sender) },
    { types: { "brAction:": "v@:@" }, name: "Action" },
  );
}

export const ACTION_SELECTOR = "brAction:";

/**
 * Priority for sizes given in ViewOptions.
 *
 * Just below Required, deliberately. A `width: 220` is a strong preference, not
 * a promise the layout can keep at every window size — and when it cannot be
 * kept, compressing the view is right and letting it spill outside its
 * container is not. Call `constrain()` yourself if you truly need Required.
 */
export const SIZE_PRIORITY = LayoutPriority.Required - 1;

export { nativeOf } from "../objc.ts";

export interface ViewOptions {
  /** Fixed width in points. */
  width?: number;
  /** Fixed height in points. */
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** In a stack, how eagerly this view takes leftover space (0 = not at all). */
  grow?: number;
  hidden?: boolean;
  tooltip?: string;
  /** Opaque identifier; also used for view reuse in tables. */
  id?: string;
  /** Corner radius (turns on a backing layer). */
  cornerRadius?: number;
  /** Background colour; accepts a Color or a CSS-ish hex string. */
  background?: any;
  alpha?: number;
}

export class View {
  readonly native: any;
  /** @internal */ _children: View[] = [];
  /** @internal */ _parent: View | null = null;
  /** @internal */ _keepAlive: any[] = [];
  /** @internal Set once `grow` has been chosen explicitly. */
  _growExplicit = false;
  // What `hidden` was last set to through this wrapper, so setting it again is free.
  #hiddenSet: boolean | undefined;

  constructor(native: any, options: ViewOptions = {}) {
    this.native = native;
    // Everything in Layer 3 is laid out with constraints, never springs.
    native.setTranslatesAutoresizingMaskIntoConstraints_(false);
    this.applyViewOptions(options);
  }

  protected applyViewOptions(o: ViewOptions) {
    if (o.width !== undefined) this.setWidth(o.width);
    if (o.height !== undefined) this.setHeight(o.height);
    if (o.minWidth !== undefined) this.constrain("width", ">=", o.minWidth, SIZE_PRIORITY);
    if (o.minHeight !== undefined) this.constrain("height", ">=", o.minHeight, SIZE_PRIORITY);
    if (o.maxWidth !== undefined) this.constrain("width", "<=", o.maxWidth, SIZE_PRIORITY);
    if (o.maxHeight !== undefined) this.constrain("height", "<=", o.maxHeight, SIZE_PRIORITY);
    if (o.grow !== undefined) this.grow = o.grow;
    if (o.hidden !== undefined) this.hidden = o.hidden;
    if (o.tooltip !== undefined) this.native.setToolTip_(o.tooltip);
    if (o.id !== undefined) this.native.setIdentifier_(o.id);
    if (o.alpha !== undefined) this.native.setAlphaValue_(o.alpha);
    if (o.cornerRadius !== undefined) {
      this.native.setWantsLayer_(true);
      this.native.layer().setCornerRadius_(o.cornerRadius);
    }
    if (o.background !== undefined) this.setBackground(o.background);
  }

  /**
   * Call `fn` when the view is clicked — any view, through an AppKit click gesture recogniser,
   * for a row or a card that does something without being a button. Side effect: adds the
   * recogniser to the view. Call it once; a second call adds a second recogniser.
   */
  onClick(fn: () => void): this {
    const target = actionTarget(() => fn());
    const recognizer = objc.NSClickGestureRecognizer.alloc().initWithTarget_action_(target, ACTION_SELECTOR);
    this.native.addGestureRecognizer_(recognizer);
    this.retainJS(target);
    this.retainJS(recognizer);
    return this;
  }

  /** Keep a JS object reachable for as long as this view is. */
  retainJS(v: any) {
    this._keepAlive.push(v);
  }

  // --- hierarchy -----------------------------------------------------------

  get children(): readonly View[] {
    return this._children;
  }

  get parent(): View | null {
    return this._parent;
  }

  add(child: View): this {
    this.native.addSubview_(child.native);
    this._children.push(child);
    child._parent = this;
    return this;
  }

  removeFromParent(): void {
    this.native.removeFromSuperview();
    if (this._parent) {
      const i = this._parent._children.indexOf(this);
      if (i >= 0) this._parent._children.splice(i, 1);
      this._parent = null;
    }
  }

  // --- geometry ------------------------------------------------------------

  get frame(): CGRect {
    return this.native.frame();
  }

  set frame(r: CGRect) {
    this.native.setFrame_(r);
  }

  get bounds(): CGRect {
    return this.native.bounds();
  }

  get intrinsicSize(): CGSize {
    return this.native.intrinsicContentSize();
  }

  get fittingSize(): CGSize {
    return this.native.fittingSize();
  }

  /**
   * The rectangle Auto Layout actually constrains. Controls like NSTextField
   * and NSButton draw a couple of points outside it, so this — not `frame` — is
   * what a width constraint of 60 makes 60 wide.
   */
  get alignmentRect(): CGRect {
    return this.native.alignmentRectForFrame_(this.native.frame());
  }

  // --- constraints ---------------------------------------------------------

  /**
   * Add a constraint against a constant, e.g. `constrain("width", ">=", 120)`.
   * Returns the NSLayoutConstraint so it can be deactivated later.
   */
  constrain(
    attribute: keyof typeof LayoutAttribute | "width" | "height",
    relation: "==" | ">=" | "<=",
    constant: number,
    priority = LayoutPriority.Required,
  ): any {
    const attrName = (attribute[0]!.toUpperCase() + attribute.slice(1)) as keyof typeof LayoutAttribute;
    const attr = LayoutAttribute[attrName] ?? LayoutAttribute[attribute as keyof typeof LayoutAttribute];
    const rel =
      relation === "==" ? LayoutRelation.Equal
      : relation === ">=" ? LayoutRelation.GreaterThanOrEqual
      : LayoutRelation.LessThanOrEqual;
    const c = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
      this.native, attr, rel, null, LayoutAttribute.NotAnAttribute, 1.0, constant,
    );
    c.setPriority_(priority);
    c.setActive_(true);
    this.retainJS(c);
    return c;
  }

  setWidth(w: number, priority = SIZE_PRIORITY): this {
    this.constrain("width", "==", w, priority);
    return this;
  }

  setHeight(h: number, priority = SIZE_PRIORITY): this {
    this.constrain("height", "==", h, priority);
    return this;
  }

  /**
   * How readily this view gives up space to its siblings in a stack.
   * 0 = never grows (hugs its content); higher = grows first.
   */
  set grow(v: number) {
    this._growExplicit = true;
    // Lower hugging = expands sooner. Keep grown views well below the packing
    // spacer (249) so they, not the spacer, absorb the slack.
    const hugging = v > 0 ? Math.max(1, 200 - v * 50) : LayoutPriority.DefaultHigh + 1;
    for (const a of [Orientation.Horizontal, Orientation.Vertical]) {
      this.native.setContentHuggingPriority_forOrientation_(hugging, a);
    }
  }

  setHugging(priority: number, axis: number): this {
    this.native.setContentHuggingPriority_forOrientation_(priority, axis);
    return this;
  }

  setCompressionResistance(priority: number, axis: number): this {
    this.native.setContentCompressionResistancePriority_forOrientation_(priority, axis);
    return this;
  }

  /** Pin every edge of `child` to this view, with optional padding. */
  fill(child: View, padding = 0): this {
    this.add(child);
    const pin = (attr: number, constant: number) => {
      const c = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
        child.native, attr, LayoutRelation.Equal, this.native, attr, 1.0, constant,
      );
      c.setActive_(true);
      this.retainJS(c);
    };
    pin(LayoutAttribute.Left, padding);
    pin(LayoutAttribute.Top, padding);
    pin(LayoutAttribute.Right, -padding);
    pin(LayoutAttribute.Bottom, -padding);
    return this;
  }

  // --- appearance ----------------------------------------------------------

  get hidden(): boolean {
    return this.native.isHidden();
  }

  /**
   * Show or hide the view. Setting what it was last set to does nothing: a hidden
   * view in a stack is a relayout of the stack, and code that writes its state
   * every frame should not be paying for one every frame.
   */
  set hidden(v: boolean) {
    const on = !!v;
    if (on === this.#hiddenSet) return;
    this.#hiddenSet = on;
    this.native.setHidden_(on);
  }

  setBackground(color: any): this {
    this.native.setWantsLayer_(true);
    const nsColor = toNSColor(color);
    if (nsColor) this.native.layer().setBackgroundColor_(nsColor.send("CGColor"));
    return this;
  }

  /** Draw a 1pt border in `color` with an optional corner radius. */
  setBorder(color: any, width = 1, radius = 0): this {
    this.native.setWantsLayer_(true);
    const layer = this.native.layer();
    const nsColor = toNSColor(color);
    if (nsColor) layer.setBorderColor_(nsColor.send("CGColor"));
    layer.setBorderWidth_(width);
    if (radius) layer.setCornerRadius_(radius);
    return this;
  }

  needsDisplay(): void {
    this.native.setNeedsDisplay_(true);
  }

  /** The window this view is in, if any. */
  get windowNative(): any {
    return this.native.window();
  }
}

// ---------------------------------------------------------------------------
// Colour helpers (shared by every view)
// ---------------------------------------------------------------------------

/** Accepts an NSColor, a "#rrggbb"/"#rrggbbaa" string, or {r,g,b,a} in 0..1. */
export function toNSColor(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && v?.native) return v.native; // a Color instance
  if (typeof v === "object" && v?.ptr !== undefined) return v; // already an NSColor
  if (typeof v === "string") return colorFromString(v);
  if (typeof v === "object") {
    return objc.NSColor.colorWithSRGBRed_green_blue_alpha_(
      v.r ?? 0, v.g ?? 0, v.b ?? 0, v.a ?? 1,
    );
  }
  return null;
}

const NAMED_COLORS: Record<string, string> = {
  label: "labelColor",
  secondaryLabel: "secondaryLabelColor",
  tertiaryLabel: "tertiaryLabelColor",
  quaternaryLabel: "quaternaryLabelColor",
  systemFill: "systemFillColor",
  secondarySystemFill: "secondarySystemFillColor",
  tertiarySystemFill: "tertiarySystemFillColor",
  quaternarySystemFill: "quaternarySystemFillColor",
  underPageBackground: "underPageBackgroundColor",
  link: "linkColor",
  separator: "separatorColor",
  windowBackground: "windowBackgroundColor",
  controlBackground: "controlBackgroundColor",
  control: "controlColor",
  controlAccent: "controlAccentColor",
  selectedContentBackground: "selectedContentBackgroundColor",
  textBackground: "textBackgroundColor",
  text: "textColor",
  clear: "clearColor",
  white: "whiteColor",
  black: "blackColor",
  red: "systemRedColor",
  green: "systemGreenColor",
  blue: "systemBlueColor",
  orange: "systemOrangeColor",
  yellow: "systemYellowColor",
  purple: "systemPurpleColor",
  pink: "systemPinkColor",
  teal: "systemTealColor",
  indigo: "systemIndigoColor",
  gray: "systemGrayColor",
  grey: "systemGrayColor",
  brown: "systemBrownColor",
  mint: "systemMintColor",
  cyan: "systemCyanColor",
};

function colorFromString(s: string): any {
  const named = NAMED_COLORS[s];
  if (named) return objc.NSColor.send(named);
  const hex = s.replace(/^#/, "");
  const parse = (i: number) => parseInt(hex.substr(i, 2), 16) / 255;
  if (hex.length === 3) {
    const c = (i: number) => parseInt(hex[i]! + hex[i]!, 16) / 255;
    return objc.NSColor.colorWithSRGBRed_green_blue_alpha_(c(0), c(1), c(2), 1);
  }
  if (hex.length === 6) {
    return objc.NSColor.colorWithSRGBRed_green_blue_alpha_(parse(0), parse(2), parse(4), 1);
  }
  if (hex.length === 8) {
    return objc.NSColor.colorWithSRGBRed_green_blue_alpha_(parse(0), parse(2), parse(4), parse(6));
  }
  return objc.NSColor.labelColor();
}
