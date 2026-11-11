// Layout containers.
//
// NSStackView covers roughly 80% of real layouts with none of the constraint
// misery, so it is the primitive here. Raw anchors remain reachable through
// View.constrain() and .native for the other 20%.

import { createDelegate, objc } from "../objc.ts";
import { View, type ViewOptions } from "./view.ts";
import {
  BorderType,
  BoxType,
  LayoutAttribute,
  LayoutPriority,
  LayoutRelation,
  Orientation,
  ScrollElasticity,
  StackDistribution,
  StackGravity,
  TitlePosition,
  VisualEffectBlendingMode,
  VisualEffectMaterial,
  VisualEffectState,
  SplitViewDividerStyle,
} from "./appkit.ts";
import type { NSEdgeInsets } from "../structs.ts";

export interface StackOptions extends ViewOptions {
  spacing?: number;
  /** Uniform padding, or per-edge. */
  padding?: number | Partial<NSEdgeInsets>;
  /** How leftover space is shared out. */
  distribution?: number;
  /** Cross-axis alignment: "leading" | "center" | "trailing" | "fill". */
  align?: "leading" | "center" | "trailing" | "fill";
  /**
   * What to do with leftover space along the stack's own axis.
   * "start" pushes the content to the top/left (the default for a column);
   * "fill" shares it out among the items (the default for a row).
   * A child with `grow` always wins over either.
   */
  pack?: "start" | "fill";
}

function insets(p: StackOptions["padding"]): NSEdgeInsets {
  if (p === undefined) return { top: 0, left: 0, bottom: 0, right: 0 };
  if (typeof p === "number") return { top: p, left: p, bottom: p, right: p };
  return { top: p.top ?? 0, left: p.left ?? 0, bottom: p.bottom ?? 0, right: p.right ?? 0 };
}

export class Stack extends View {
  readonly orientation: number;
  readonly align: "leading" | "center" | "trailing" | "fill";
  #insets: NSEdgeInsets;

  constructor(orientation: number, options: StackOptions = {}, children: View[] = []) {
    const native = objc.NSStackView.alloc().init();
    native.setOrientation_(orientation);
    super(native, options);
    this.orientation = orientation;

    const horizontal = orientation === Orientation.Horizontal;
    this.#insets = insets(options.padding);
    native.setSpacing_(options.spacing ?? 8);
    native.setEdgeInsets_(this.#insets);
    native.setDistribution_(options.distribution ?? StackDistribution.Fill);

    // A vertical stack almost always wants its rows full width; a horizontal
    // one almost always wants its items vertically centred.
    this.align = options.align ?? (horizontal ? "center" : "fill");

    // NSStackView's `alignment` is a *cross-axis* NSLayoutAttribute, and only a
    // few values are legal per orientation — Width/Height are silently ignored,
    // which is why "fill" is implemented with our own constraints below.
    const attr = horizontal
      ? { leading: LayoutAttribute.Top, center: LayoutAttribute.CenterY,
          trailing: LayoutAttribute.Bottom, fill: LayoutAttribute.Top }[this.align]
      : { leading: LayoutAttribute.Leading, center: LayoutAttribute.CenterX,
          trailing: LayoutAttribute.Trailing, fill: LayoutAttribute.Leading }[this.align];
    native.setAlignment_(attr);

    for (const c of children) this.add(c);

    // A column of rows should sit at the top with the slack below it, which is
    // not something NSStackView expresses; a trailing flexible view is how you
    // say it. Rows default to sharing the slack instead.
    const pack = options.pack ?? (horizontal ? "fill" : "start");
    if (pack === "start") {
      const filler = objc.NSView.alloc().init();
      filler.setTranslatesAutoresizingMaskIntoConstraints_(false);
      for (const a of [Orientation.Horizontal, Orientation.Vertical]) {
        filler.setContentHuggingPriority_forOrientation_(249, a);
        filler.setContentCompressionResistancePriority_forOrientation_(1, a);
      }
      native.addArrangedSubview_(filler);
      this.#filler = filler;
    }
  }

  // Kept out of `children` — it is layout plumbing, not part of the tree.
  #filler: any = null;

  // "fill" means every item spans the stack's cross axis. NSStackView will not
  // do this for us, so each arranged subview gets one constraint tying its
  // cross-axis size to the stack's, minus the edge insets. Priority 999 lets an
  // explicit width/height (which is Required) win instead of conflicting.
  // Growth along the main axis is opt-in: without this, whichever view happens
  // to have the lowest built-in hugging priority silently swallows all the
  // spare space, which is impossible to reason about. Pass `grow` to opt in.
  #applyMainAxisHugging(child: View) {
    if (child._growExplicit) return;
    const axis = this.orientation === Orientation.Horizontal
      ? Orientation.Horizontal
      : Orientation.Vertical;
    child.native.setContentHuggingPriority_forOrientation_(LayoutPriority.DefaultHigh, axis);
  }

  #applyFill(child: View) {
    if (this.align !== "fill") return;
    const horizontal = this.orientation === Orientation.Horizontal;
    const attr = horizontal ? LayoutAttribute.Height : LayoutAttribute.Width;
    const inset = horizontal
      ? this.#insets.top + this.#insets.bottom
      : this.#insets.left + this.#insets.right;
    const c = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
      child.native, attr, LayoutRelation.Equal, this.native, attr, 1.0, -inset,
    );
    c.setPriority_(999);
    c.setActive_(true);
    this.retainJS(c);
  }

  // An arranged subview is added by NSStackView itself, so we only mirror the
  // bookkeeping rather than calling View.add (which would add it twice).
  add(child: View): this {
    if (this.#filler) {
      this.native.insertArrangedSubview_atIndex_(child.native, this._children.length);
    } else {
      this.native.addArrangedSubview_(child.native);
    }
    this._children.push(child);
    child._parent = this;
    this.#applyFill(child);
    this.#applyMainAxisHugging(child);
    return this;
  }

  insert(child: View, index: number): this {
    this.native.insertArrangedSubview_atIndex_(child.native, index);
    this._children.splice(index, 0, child);
    child._parent = this;
    this.#applyFill(child);
    this.#applyMainAxisHugging(child);
    return this;
  }

  remove(child: View): this {
    this.native.removeArrangedSubview_(child.native);
    child.native.removeFromSuperview();
    const i = this._children.indexOf(child);
    if (i >= 0) this._children.splice(i, 1);
    child._parent = null;
    return this;
  }

  removeAll(): this {
    for (const c of [...this.children]) this.remove(c);
    return this;
  }

  set spacing(v: number) {
    this.native.setSpacing_(v);
  }

  /** Pin a view to a gravity area (leading/center/trailing). */
  addToGravity(child: View, gravity: number): this {
    this.native.addView_inGravity_(child.native, gravity);
    this._children.push(child);
    child._parent = this;
    return this;
  }
}

export class VStack extends Stack {
  constructor(options: StackOptions = {}, children: View[] = []) {
    super(Orientation.Vertical, options, children);
  }
}

export class HStack extends Stack {
  constructor(options: StackOptions = {}, children: View[] = []) {
    super(Orientation.Horizontal, options, children);
  }
}

/** Flexible empty space. Put one between two views to push them apart. */
export class Spacer extends View {
  constructor(options: { min?: number } = {}) {
    const v = objc.NSView.alloc().init();
    super(v, {});
    this.setHugging(LayoutPriority.FittingSizeCompression, Orientation.Horizontal);
    this.setHugging(LayoutPriority.FittingSizeCompression, Orientation.Vertical);
    this.setCompressionResistance(1, Orientation.Horizontal);
    this.setCompressionResistance(1, Orientation.Vertical);
    if (options.min !== undefined) {
      this.constrain("width", ">=", options.min, LayoutPriority.DefaultLow);
      this.constrain("height", ">=", options.min, LayoutPriority.DefaultLow);
    }
  }
}

/** A 1px separator line. */
export class Separator extends View {
  constructor(orientation: number = Orientation.Horizontal) {
    const b = objc.NSBox.alloc().init();
    b.setBoxType_(BoxType.Separator);
    super(b, {});
    if (orientation === Orientation.Horizontal) this.setHeight(1);
    else this.setWidth(1);
  }
}

export interface ScrollOptions extends ViewOptions {
  horizontal?: boolean;
  vertical?: boolean;
  border?: boolean;
  /** Let the document view stretch to the scroll view's width. */
  fitWidth?: boolean;
}

/**
 * A plain view that says it is flipped — the document of a {@link ScrollView}. Stateless, so a
 * document AppKit is still tearing down after its scroll view's wrapper was collected still says
 * so, rather than warning that its handlers are gone.
 */
function flippedDocument(): any {
  return createDelegate(
    { isFlipped: () => true },
    { superclass: "NSView", name: "FlippedDocument", types: { isFlipped: "B@:" }, stateless: true },
  );
}

/** A scrolling container around a single content view. */
export class ScrollView extends View {
  #content: View | null = null;

  constructor(options: ScrollOptions = {}, content?: View) {
    const sv = objc.NSScrollView.alloc().init();
    sv.setHasVerticalScroller_(options.vertical !== false);
    sv.setHasHorizontalScroller_(options.horizontal === true);
    sv.setAutohidesScrollers_(true);
    sv.setBorderType_(options.border ? BorderType.Bezel : BorderType.None);
    sv.setDrawsBackground_(false);
    // Insets come from the layout, never from AppKit guessing: in a full-size-content window
    // a scroll view otherwise insets itself by the toolbar's height, on top of a pane that
    // already keeps to its safe area, and its first rows start scrolled out of sight.
    sv.setAutomaticallyAdjustsContentInsets_(false);
    if (options.horizontal !== true) sv.setHorizontalScrollElasticity_(ScrollElasticity.None);
    super(sv, options);
    // An NSScrollView has no intrinsic height, so give it a floor rather than
    // letting it vanish in a stack that hugs its content.
    if (options.height === undefined && options.minHeight === undefined) {
      this.constrain("height", ">=", 80);
    }
    if (content) this.content = content;
  }

  get content(): View | null {
    return this.#content;
  }

  set content(v: View | null) {
    this.#content = v;
    if (!v) {
      this.native.setDocumentView_(null);
      return;
    }
    // The content sits in a **flipped** document, so the top of it is y = 0 and it grows
    // downwards. AppKit's default document is not flipped: its origin is the bottom-left, a
    // document that grows after it is shown grows *upwards* out of view, and a page whose
    // tables fill in a frame later opens scrolled part-way down its own contents.
    const doc = flippedDocument();
    doc.setTranslatesAutoresizingMaskIntoConstraints_(false);
    doc.addSubview_(v.native);
    const pin = (item: any, attr: number, to: any) => {
      const c = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
        item, attr, LayoutRelation.Equal, to, attr, 1.0, 0,
      );
      c.setActive_(true);
      this.retainJS(c);
    };
    for (const attr of [LayoutAttribute.Top, LayoutAttribute.Leading, LayoutAttribute.Trailing, LayoutAttribute.Bottom]) {
      pin(v.native, attr, doc);
    }
    this.native.setDocumentView_(doc);
    this.retainJS(doc);
    // A document view sized by constraints still needs its width pinned to the
    // clip view, otherwise it collapses to its intrinsic width.
    pin(doc, LayoutAttribute.Width, this.native.contentView());
  }

  scrollToTop(): void {
    const doc = this.native.documentView();
    if (doc) this.native.contentView().scrollToPoint_({ x: 0, y: 0 });
    this.native.reflectScrolledClipView_(this.native.contentView());
  }

  scrollToBottom(): void {
    const doc = this.native.documentView();
    if (!doc) return;
    const h = doc.frame().height;
    const vh = this.native.contentView().bounds().height;
    this.native.contentView().scrollToPoint_({ x: 0, y: Math.max(0, h - vh) });
    this.native.reflectScrolledClipView_(this.native.contentView());
  }
}

export interface BoxOptions extends ViewOptions {
  title?: string;
  padding?: number;
  spacing?: number;
  /** Border colour; pass null for no border. */
  border?: any;
  radius?: number;
}

/**
 * A titled group of controls.
 *
 * Deliberately not an NSBox: NSBox positions its content view with springs and
 * derives no intrinsic size from it, so a constraint-driven NSBox collapses to
 * nothing. This is a plain bordered container instead, which behaves.
 */
export class GroupBox extends View {
  readonly contentStack: VStack;
  readonly titleLabel: View | null = null;

  constructor(options: BoxOptions = {}, children: View[] = []) {
    const outer = objc.NSStackView.alloc().init();
    outer.setOrientation_(Orientation.Vertical);
    outer.setSpacing_(6);
    outer.setAlignment_(LayoutAttribute.Leading);
    outer.setDistribution_(StackDistribution.Fill);
    super(outer, options);

    if (options.title !== undefined) {
      const label = objc.NSTextField.labelWithString_(options.title);
      label.setTranslatesAutoresizingMaskIntoConstraints_(false);
      label.setFont_(objc.NSFont.systemFontOfSize_weight_(11, 0.3));
      label.setTextColor_(objc.NSColor.secondaryLabelColor());
      outer.addArrangedSubview_(label);
      this.titleLabel = new View(label, {});
    }

    this.contentStack = new VStack({
      spacing: options.spacing ?? 8,
      padding: options.padding ?? 10,
    }, children);
    if (options.border !== null) {
      this.contentStack.setBorder(options.border ?? "separator", 1, options.radius ?? 8);
    }
    outer.addArrangedSubview_(this.contentStack.native);
    this._children.push(this.contentStack);
    this.contentStack._parent = this;

    // Title and body both span the group's full width.
    for (const v of [this.titleLabel, this.contentStack]) {
      if (!v) continue;
      const c = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
        v.native, LayoutAttribute.Width, LayoutRelation.Equal, outer, LayoutAttribute.Width, 1.0, 0,
      );
      c.setPriority_(999);
      c.setActive_(true);
      this.retainJS(c);
    }
  }

  add(child: View): this {
    this.contentStack.add(child);
    return this;
  }

  removeAll(): this {
    this.contentStack.removeAll();
    return this;
  }
}

export interface BlurOptions extends ViewOptions {
  material?: number;
  blending?: number;
}

/** A translucent "vibrancy" background, as used by sidebars and HUDs. */
export class BlurView extends View {
  constructor(options: BlurOptions = {}, content?: View) {
    const v = objc.NSVisualEffectView.alloc().init();
    v.setMaterial_(options.material ?? VisualEffectMaterial.Sidebar);
    v.setBlendingMode_(options.blending ?? VisualEffectBlendingMode.BehindWindow);
    v.setState_(VisualEffectState.Active);
    super(v, options);
    if (content) this.fill(content);
  }
}

/** A plain container you can fill or position children in yourself. */
export class Container extends View {
  constructor(options: ViewOptions = {}, children: View[] = []) {
    super(objc.NSView.alloc().init(), options);
    for (const c of children) this.add(c);
  }
}

export interface SplitOptions extends ViewOptions {
  vertical?: boolean;
  /** Initial position of the divider, in points from the leading edge. */
  position?: number;
  thickness?: number;
}

export class SplitView extends View {
  constructor(options: SplitOptions = {}, panes: View[] = []) {
    const sv = objc.NSSplitView.alloc().init();
    sv.setVertical_(options.vertical !== false);
    sv.setDividerStyle_(SplitViewDividerStyle.Thin);
    super(sv, options);
    for (const p of panes) this.addPane(p);
    if (options.position !== undefined) {
      // Applied once the view has a size.
      queueMicrotask(() => this.setPosition(options.position!, 0));
    }
  }

  addPane(v: View): this {
    this.native.addArrangedSubview_(v.native);
    this._children.push(v);
    v._parent = this;
    return this;
  }

  setPosition(points: number, dividerIndex = 0): void {
    this.native.setPosition_ofDividerAtIndex_(points, dividerIndex);
  }
}
