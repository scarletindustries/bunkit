// Controls — labels, buttons, fields, and the rest of the everyday widgets.
//
// Every control exposes events as plain callbacks (`onClick`, `onChange`); the
// delegate and target/action machinery stays out of sight in Layer 2.

import { createDelegate, objc, str } from "../objc.ts";
import * as C from "../generated/constants.ts";
import { ACTION_SELECTOR, actionTarget, toNSColor, View, type ViewOptions } from "./view.ts";
import {
  AutoresizingMask,
  BezelStyle,
  BorderType,
  ButtonType,
  ControlSize,
  ControlState,
  FontWeight,
  ImagePosition,
  ImageScaling,
  LineBreakMode,
  Orientation,
  ProgressIndicatorStyle,
  SegmentStyle,
  TextAlignment,
  TextFieldBezelStyle,
} from "./appkit.ts";

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export type FontWeightName =
  | "ultraLight" | "thin" | "light" | "regular"
  | "medium" | "semibold" | "bold" | "heavy" | "black";

export interface FontSpec {
  size?: number;
  weight?: number | FontWeightName;
  monospace?: boolean;
  /**
   * The system font with fixed-width **digits** only — for a clock or a column of numbers that
   * must not jitter as it changes, in a line that is otherwise ordinary text.
   */
  digits?: boolean;
  /** Use the system font at a semantic size instead of a point size. */
  style?: "body" | "title" | "headline" | "caption" | "largeTitle";
}

const STYLE_SIZES: Record<string, number> = {
  largeTitle: 26,
  title: 20,
  headline: 15,
  body: 13,
  caption: 11,
};

const WEIGHTS: Record<FontWeightName, number> = {
  ultraLight: FontWeight.UltraLight,
  thin: FontWeight.Thin,
  light: FontWeight.Light,
  regular: FontWeight.Regular,
  medium: FontWeight.Medium,
  semibold: FontWeight.Semibold,
  bold: FontWeight.Bold,
  heavy: FontWeight.Heavy,
  black: FontWeight.Black,
};

export function makeFont(spec: FontSpec | number | undefined): any {
  if (spec === undefined) return null;
  if (typeof spec === "number") return objc.NSFont.systemFontOfSize_(spec);
  const size = spec.size ?? (spec.style ? STYLE_SIZES[spec.style]! : 13);
  const weight =
    typeof spec.weight === "string" ? WEIGHTS[spec.weight] : (spec.weight ?? FontWeight.Regular);
  if (spec.monospace) return objc.NSFont.monospacedSystemFontOfSize_weight_(size, weight);
  if (spec.digits) return objc.NSFont.monospacedDigitSystemFontOfSize_weight_(size, weight);
  return objc.NSFont.systemFontOfSize_weight_(size, weight);
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

export interface LabelOptions extends ViewOptions {
  text?: string;
  font?: FontSpec | number;
  color?: any;
  align?: "left" | "center" | "right";
  /** Wrap onto multiple lines instead of truncating. */
  wrap?: boolean;
  /**
   * Where a single line too long for its width loses text, behind an ellipsis — the end
   * (default), the middle (a path, a long name whose end matters), or the start. AppKit's own
   * default for a label is to **clip**, cutting a word mid-letter with nothing to say there was
   * more; the HIG wants the ellipsis.
   */
  truncate?: "tail" | "middle" | "head";
  selectable?: boolean;
  lines?: number;
}

export class Label extends View {
  // What the text was last set to through this wrapper, so setting it again is free.
  #text: string;

  constructor(options: LabelOptions = {}) {
    const f = objc.NSTextField.labelWithString_(options.text ?? "");
    super(f, options);
    this.#text = options.text ?? "";
    this.applyLabelOptions(options);
  }

  protected applyLabelOptions(o: LabelOptions) {
    const f = this.native;
    if (o.font !== undefined) f.setFont_(makeFont(o.font));
    if (o.color !== undefined) f.setTextColor_(toNSColor(o.color));
    if (o.align !== undefined) {
      f.setAlignment_(
        o.align === "center" ? TextAlignment.Center
        : o.align === "right" ? TextAlignment.Right
        : TextAlignment.Left,
      );
    }
    if (o.selectable !== undefined) f.setSelectable_(o.selectable);
    if (!o.wrap) {
      f.setLineBreakMode_(
        o.truncate === "middle" ? LineBreakMode.TruncatingMiddle
        : o.truncate === "head" ? LineBreakMode.TruncatingHead
        : LineBreakMode.TruncatingTail,
      );
    }
    if (o.wrap) {
      f.setLineBreakMode_(LineBreakMode.WordWrapping);
      f.cell().setWraps_(true);
      f.setUsesSingleLineMode_(false);
      if (o.lines !== undefined) f.setMaximumNumberOfLines_(o.lines);
      // A wrapping label must know how wide it is allowed to be.
      f.setPreferredMaxLayoutWidth_(o.width ?? o.maxWidth ?? 0);
    }
  }

  get text(): string {
    return str(this.native.stringValue());
  }

  /**
   * Set the text. The same text again does nothing: `setStringValue:` marks the
   * label's size stale and its window for layout even when nothing changed, and
   * a readout refreshed twenty times a second would otherwise relayout twenty
   * times a second for digits that did not move.
   */
  set text(v: string) {
    const next = v ?? "";
    if (next === this.#text) return;
    this.#text = next;
    this.native.setStringValue_(next);
  }

  set color(v: any) {
    this.native.setTextColor_(toNSColor(v));
  }

  set font(v: FontSpec | number) {
    this.native.setFont_(makeFont(v));
  }
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

const PROMINENCE = {
  automatic: C.NSTintProminenceAutomatic,
  none: C.NSTintProminenceNone,
  primary: C.NSTintProminencePrimary,
  secondary: C.NSTintProminenceSecondary,
} as const;

const SHAPES = {
  automatic: C.NSControlBorderShapeAutomatic,
  capsule: C.NSControlBorderShapeCapsule,
  circle: C.NSControlBorderShapeCircle,
  roundedRectangle: C.NSControlBorderShapeRoundedRectangle,
} as const;

export interface ButtonOptions extends ViewOptions {
  title?: string;
  onClick?: (button: Button) => void;
  /** Draw as the window's default button and respond to Return. */
  primary?: boolean;
  destructive?: boolean;
  enabled?: boolean;
  /** An SF Symbol name, e.g. "plus.circle". */
  symbol?: string;
  bezel?: number;
  size?: number;
  key?: string;
  bordered?: boolean;
  /** Liquid Glass (macOS 26): for a button that floats over content. */
  glass?: boolean;
  /**
   * How strongly the button is tinted (macOS 26). `"primary"` is the one action the view is
   * for; `"secondary"` tints without competing with it.
   */
  prominence?: "automatic" | "none" | "primary" | "secondary";
  /** The bezel's colour — with `prominence: "primary"`, the colour of the whole button. */
  tint?: any;
  /** The bezel's shape (macOS 26). */
  shape?: "automatic" | "capsule" | "circle" | "roundedRectangle";
}

export class Button extends View {
  #handler: ((b: Button) => void) | null = null;
  // What the title was last set to through this wrapper, so setting it again is free.
  #title: string;

  constructor(options: ButtonOptions = {}) {
    const b = objc.NSButton.buttonWithTitle_target_action_(options.title ?? "", null, null);
    super(b, options);
    this.#title = options.title ?? "";

    if (options.symbol) {
      const img = objc.NSImage.imageWithSystemSymbolName_accessibilityDescription_(
        options.symbol, options.title ?? options.symbol,
      );
      if (img) {
        b.setImage_(img);
        b.setImagePosition_(options.title ? ImagePosition.ImageLeft : ImagePosition.ImageOnly);
      }
    }
    if (options.bezel !== undefined) b.setBezelStyle_(options.bezel);
    if (options.glass) b.setBezelStyle_(BezelStyle.Glass);
    if (options.prominence !== undefined) b.setTintProminence_(PROMINENCE[options.prominence]);
    if (options.tint !== undefined) b.setBezelColor_(toNSColor(options.tint));
    if (options.shape !== undefined) b.setBorderShape_(SHAPES[options.shape]);
    if (options.size !== undefined) b.setControlSize_(options.size);
    if (options.bordered !== undefined) b.setBordered_(options.bordered);
    if (options.enabled !== undefined) b.setEnabled_(options.enabled);
    if (options.primary) b.setKeyEquivalent_("\r");
    if (options.key) b.setKeyEquivalent_(options.key);
    if (options.destructive) {
      b.setContentTintColor_(toNSColor("red"));
      if (b.respondsTo("setHasDestructiveAction:")) b.setHasDestructiveAction_(true);
    }
    if (options.onClick) this.onClick(options.onClick);
  }

  onClick(fn: (b: Button) => void): this {
    this.#handler = fn;
    const target = actionTarget(() => this.#handler?.(this));
    this.retainJS(target);
    this.native.setTarget_(target);
    this.native.setAction_(ACTION_SELECTOR);
    return this;
  }

  /** Fire the button's action as though the user clicked it. */
  click(): void {
    this.native.performClick_(null);
  }

  /** Re-tint the bezel; `null` for none. */
  set tint(color: any) {
    this.native.setBezelColor_(toNSColor(color));
  }

  /** Change how strongly it is tinted. */
  set prominence(p: "automatic" | "none" | "primary" | "secondary") {
    this.native.setTintProminence_(PROMINENCE[p]);
  }

  /** Show an SF Symbol, or none. */
  set symbol(name: string | undefined) {
    const img = name ? objc.NSImage.imageWithSystemSymbolName_accessibilityDescription_(name, name) : null;
    this.native.setImage_(img);
    this.native.setImagePosition_(
      !img ? ImagePosition.NoImage : this.title ? ImagePosition.ImageLeading : ImagePosition.ImageOnly,
    );
  }

  get title(): string {
    return str(this.native.title());
  }

  /** Set the title. The same title again does nothing — see `Label.text`. */
  set title(v: string) {
    const next = v ?? "";
    if (next === this.#title) return;
    this.#title = next;
    this.native.setTitle_(next);
  }

  get enabled(): boolean {
    return this.native.isEnabled();
  }

  set enabled(v: boolean) {
    this.native.setEnabled_(v);
  }
}

// ---------------------------------------------------------------------------
// Checkbox / Switch / Radio
// ---------------------------------------------------------------------------

export interface CheckboxOptions extends ViewOptions {
  title?: string;
  checked?: boolean;
  onChange?: (checked: boolean, cb: Checkbox) => void;
  enabled?: boolean;
}

export class Checkbox extends View {
  #handler: ((checked: boolean, cb: Checkbox) => void) | null = null;

  constructor(options: CheckboxOptions = {}) {
    const b = objc.NSButton.checkboxWithTitle_target_action_(options.title ?? "", null, null);
    super(b, options);
    if (options.checked !== undefined) this.checked = options.checked;
    if (options.enabled !== undefined) b.setEnabled_(options.enabled);
    if (options.onChange) this.onChange(options.onChange);
  }

  onChange(fn: (checked: boolean, cb: Checkbox) => void): this {
    this.#handler = fn;
    const target = actionTarget(() => this.#handler?.(this.checked, this));
    this.retainJS(target);
    this.native.setTarget_(target);
    this.native.setAction_(ACTION_SELECTOR);
    return this;
  }

  get checked(): boolean {
    return Number(this.native.state()) === ControlState.On;
  }

  set checked(v: boolean) {
    this.native.setState_(v ? ControlState.On : ControlState.Off);
  }

  get title(): string {
    return str(this.native.title());
  }

  set title(v: string) {
    this.native.setTitle_(v);
  }
}

export class Switch extends View {
  #handler: ((on: boolean, s: Switch) => void) | null = null;

  constructor(options: { on?: boolean; onChange?: (on: boolean, s: Switch) => void } & ViewOptions = {}) {
    const s = objc.NSSwitch.alloc().init();
    super(s, options);
    if (options.on !== undefined) this.on = options.on;
    if (options.onChange) this.onChange(options.onChange);
  }

  onChange(fn: (on: boolean, s: Switch) => void): this {
    this.#handler = fn;
    const target = actionTarget(() => this.#handler?.(this.on, this));
    this.retainJS(target);
    this.native.setTarget_(target);
    this.native.setAction_(ACTION_SELECTOR);
    return this;
  }

  get on(): boolean {
    return Number(this.native.state()) === ControlState.On;
  }

  set on(v: boolean) {
    this.native.setState_(v ? ControlState.On : ControlState.Off);
  }
}

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------

export interface TextFieldOptions extends ViewOptions {
  value?: string;
  placeholder?: string;
  /** Fires on every keystroke. */
  onChange?: (value: string, field: TextField) => void;
  /** Fires when the user presses Return or the field loses focus. */
  onSubmit?: (value: string, field: TextField) => void;
  secure?: boolean;
  editable?: boolean;
  font?: FontSpec | number;
  align?: "left" | "center" | "right";
  enabled?: boolean;
}

export class TextField extends View {
  #onChange: ((v: string, f: TextField) => void) | null = null;
  #onSubmit: ((v: string, f: TextField) => void) | null = null;

  constructor(options: TextFieldOptions = {}) {
    const f = options.secure
      ? objc.NSSecureTextField.alloc().init()
      : objc.NSTextField.alloc().init();
    super(f, options);

    if (options.value !== undefined) f.setStringValue_(options.value);
    if (options.placeholder !== undefined) f.setPlaceholderString_(options.placeholder);
    if (options.editable !== undefined) f.setEditable_(options.editable);
    if (options.enabled !== undefined) f.setEnabled_(options.enabled);
    if (options.font !== undefined) f.setFont_(makeFont(options.font));
    if (options.align !== undefined) {
      f.setAlignment_(
        options.align === "center" ? TextAlignment.Center
        : options.align === "right" ? TextAlignment.Right
        : TextAlignment.Left,
      );
    }
    f.setBezelStyle_(TextFieldBezelStyle.Square);
    f.setBezeled_(true);

    this.#onChange = options.onChange ?? null;
    this.#onSubmit = options.onSubmit ?? null;
    this.installDelegate();
  }

  private installDelegate() {
    const d = createDelegate(
      {
        controlTextDidChange_: () => this.#onChange?.(this.value, this),
        controlTextDidEndEditing_: () => this.#onSubmit?.(this.value, this),
      },
      { protocols: ["NSTextFieldDelegate"], name: "TextField" },
    );
    this.retainJS(d);
    this.native.setDelegate_(d);
    // Return key also fires the action.
    const target = actionTarget(() => this.#onSubmit?.(this.value, this));
    this.retainJS(target);
    this.native.setTarget_(target);
    this.native.setAction_(ACTION_SELECTOR);
  }

  onChange(fn: (v: string, f: TextField) => void): this {
    this.#onChange = fn;
    return this;
  }

  onSubmit(fn: (v: string, f: TextField) => void): this {
    this.#onSubmit = fn;
    return this;
  }

  get value(): string {
    return str(this.native.stringValue());
  }

  set value(v: string) {
    this.native.setStringValue_(v ?? "");
  }

  focus(): void {
    const w = this.native.window();
    if (w) w.makeFirstResponder_(this.native);
  }

  selectAll(): void {
    this.native.selectText_(null);
  }
}

// ---------------------------------------------------------------------------
// TextView (multi-line)
// ---------------------------------------------------------------------------

export interface TextAreaOptions extends ViewOptions {
  value?: string;
  onChange?: (value: string, t: TextArea) => void;
  font?: FontSpec | number;
  editable?: boolean;
  richText?: boolean;
}

export class TextArea extends View {
  readonly textView: any;
  #onChange: ((v: string, t: TextArea) => void) | null = null;

  constructor(options: TextAreaOptions = {}) {
    const scroll = objc.NSScrollView.alloc().init();
    scroll.setHasVerticalScroller_(true);
    scroll.setBorderType_(BorderType.Bezel);
    const tv = objc.NSTextView.alloc().init();
    tv.setMinSize_({ width: 0, height: 0 });
    tv.setMaxSize_({ width: 1e7, height: 1e7 });
    tv.setVerticallyResizable_(true);
    tv.setHorizontallyResizable_(false);
    tv.setAutoresizingMask_(AutoresizingMask.WidthSizable);
    tv.textContainer().setWidthTracksTextView_(true);
    tv.setRichText_(options.richText ?? false);
    if (options.editable !== undefined) tv.setEditable_(options.editable);
    if (options.font !== undefined) tv.setFont_(makeFont(options.font));
    if (options.value !== undefined) tv.setString_(options.value);
    scroll.setDocumentView_(tv);

    super(scroll, options);
    if (options.height === undefined && options.minHeight === undefined) {
      this.constrain("height", ">=", 80);
    }
    this.textView = tv;
    this.#onChange = options.onChange ?? null;

    const d = createDelegate(
      { textDidChange_: () => this.#onChange?.(this.value, this) },
      { protocols: ["NSTextViewDelegate"], name: "TextView" },
    );
    this.retainJS(d);
    tv.setDelegate_(d);
  }

  get value(): string {
    return str(this.textView.string());
  }

  set value(v: string) {
    this.textView.setString_(v ?? "");
  }

  append(v: string): void {
    this.textView.setString_(this.value + v);
    this.textView.scrollRangeToVisible_({ location: this.value.length, length: 0 });
  }
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export interface SliderOptions extends ViewOptions {
  value?: number;
  min?: number;
  max?: number;
  ticks?: number;
  onChange?: (value: number, s: Slider) => void;
  vertical?: boolean;
}

export class Slider extends View {
  #handler: ((v: number, s: Slider) => void) | null = null;

  constructor(options: SliderOptions = {}) {
    const s = objc.NSSlider.alloc().init();
    s.setMinValue_(options.min ?? 0);
    s.setMaxValue_(options.max ?? 1);
    s.setDoubleValue_(options.value ?? options.min ?? 0);
    if (options.ticks) {
      s.setNumberOfTickMarks_(options.ticks);
      s.setAllowsTickMarkValuesOnly_(false);
    }
    if (options.vertical) s.setVertical_(true);
    super(s, options);
    if (options.onChange) this.onChange(options.onChange);
  }

  onChange(fn: (v: number, s: Slider) => void): this {
    this.#handler = fn;
    const target = actionTarget(() => this.#handler?.(this.value, this));
    this.retainJS(target);
    this.native.setTarget_(target);
    this.native.setAction_(ACTION_SELECTOR);
    this.native.setContinuous_(true);
    return this;
  }

  get value(): number {
    return Number(this.native.doubleValue());
  }

  set value(v: number) {
    this.native.setDoubleValue_(v);
  }
}

// ---------------------------------------------------------------------------
// PopUpButton / SegmentedControl
// ---------------------------------------------------------------------------

export interface SelectOptions extends ViewOptions {
  items?: string[];
  selected?: number;
  onChange?: (index: number, title: string, s: Select) => void;
  enabled?: boolean;
}

export class Select extends View {
  #handler: ((i: number, t: string, s: Select) => void) | null = null;

  /**
   * A pop-up menu of titles. The button draws an item of its own rather than the one in the
   * menu (`usesItemFromMenu` off, kept in step by {@link #showSelected}): drawing from the menu
   * costs its layout a pass over every item, and a window of eight 16-item dropdowns took 87 ms
   * to lay out, against 28 ms this way — on a main thread that renders a lighting show.
   */
  constructor(options: SelectOptions = {}) {
    const p = objc.NSPopUpButton.alloc().initWithFrame_pullsDown_(
      { x: 0, y: 0, width: 120, height: 25 }, false,
    );
    super(p, options);
    p.cell().setUsesItemFromMenu_(false);
    // Always a target, handler or not: a choice has to update the item the button draws.
    const target = actionTarget(() => {
      this.#showSelected();
      this.#handler?.(this.selectedIndex, this.selectedTitle, this);
    });
    this.retainJS(target);
    p.setTarget_(target);
    p.setAction_(ACTION_SELECTOR);
    if (options.items) this.items = options.items;
    if (options.selected !== undefined) this.selectedIndex = options.selected;
    if (options.enabled !== undefined) p.setEnabled_(options.enabled);
    if (options.onChange) this.onChange(options.onChange);
  }

  /** Call `fn` when a person chooses an item. Replaces any handler set before. */
  onChange(fn: (i: number, t: string, s: Select) => void): this {
    this.#handler = fn;
    return this;
  }

  /** The titles, in order. Side effect: the first is selected, as AppKit does. */
  set items(v: string[]) {
    this.native.removeAllItems();
    for (const t of v) this.native.addItemWithTitle_(t);
    this.#showSelected();
  }

  get selectedIndex(): number {
    return Number(this.native.indexOfSelectedItem());
  }

  set selectedIndex(i: number) {
    this.native.selectItemAtIndex_(i);
    this.#showSelected();
  }

  /** Draw the selected item on the button — a copy, since an item belongs to one menu. */
  #showSelected(): void {
    const item = this.native.selectedItem();
    this.native.cell().setMenuItem_(item && item.ptr !== 0n ? item.copy() : null);
  }

  get selectedTitle(): string {
    return str(this.native.titleOfSelectedItem());
  }
}

export interface SegmentedOptions extends ViewOptions {
  items: string[];
  selected?: number;
  onChange?: (index: number, s: Segmented) => void;
}

export class Segmented extends View {
  #handler: ((i: number, s: Segmented) => void) | null = null;

  constructor(options: SegmentedOptions) {
    const sc = objc.NSSegmentedControl.alloc().init();
    sc.setSegmentCount_(options.items.length);
    options.items.forEach((t, i) => {
      sc.setLabel_forSegment_(t, i);
      sc.setWidth_forSegment_(0, i);
    });
    sc.setSegmentStyle_(SegmentStyle.Rounded);
    sc.setSelectedSegment_(options.selected ?? 0);
    super(sc, options);
    if (options.onChange) this.onChange(options.onChange);
  }

  onChange(fn: (i: number, s: Segmented) => void): this {
    this.#handler = fn;
    const target = actionTarget(() => this.#handler?.(this.selectedIndex, this));
    this.retainJS(target);
    this.native.setTarget_(target);
    this.native.setAction_(ACTION_SELECTOR);
    return this;
  }

  get selectedIndex(): number {
    return Number(this.native.selectedSegment());
  }

  set selectedIndex(i: number) {
    this.native.setSelectedSegment_(i);
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface ProgressOptions extends ViewOptions {
  value?: number;
  max?: number;
  indeterminate?: boolean;
  spinner?: boolean;
}

export class Progress extends View {
  constructor(options: ProgressOptions = {}) {
    const p = objc.NSProgressIndicator.alloc().init();
    p.setStyle_(options.spinner ? ProgressIndicatorStyle.Spinning : ProgressIndicatorStyle.Bar);
    p.setIndeterminate_(options.indeterminate ?? !!options.spinner);
    p.setMinValue_(0);
    p.setMaxValue_(options.max ?? 1);
    p.setDoubleValue_(options.value ?? 0);
    super(p, options);
    if (options.indeterminate || options.spinner) p.startAnimation_(null);
  }

  get value(): number {
    return Number(this.native.doubleValue());
  }

  set value(v: number) {
    this.native.setDoubleValue_(v);
  }

  start(): void {
    this.native.startAnimation_(null);
  }

  stop(): void {
    this.native.stopAnimation_(null);
  }
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export interface ImageOptions extends ViewOptions {
  /** File path, SF Symbol name (prefix "sf:"), or an NSImage. */
  src?: string | any;
  scaling?: number;
}

export class ImageView extends View {
  constructor(options: ImageOptions = {}) {
    const v = objc.NSImageView.alloc().init();
    v.setImageScaling_(options.scaling ?? ImageScaling.ProportionallyUpOrDown);
    super(v, options);
    if (options.src !== undefined) this.src = options.src;
  }

  set src(v: string | any) {
    this.native.setImage_(loadImage(v));
  }
}

export function loadImage(src: string | any): any {
  if (src === null || src === undefined) return null;
  if (typeof src !== "string") return src;
  if (src.startsWith("sf:")) {
    return objc.NSImage.imageWithSystemSymbolName_accessibilityDescription_(src.slice(3), null);
  }
  if (src.startsWith("named:")) {
    return objc.NSImage.imageNamed_(src.slice(6));
  }
  return objc.NSImage.alloc().initWithContentsOfFile_(src);
}

export { BezelStyle, ButtonType, ControlSize, ControlState, Orientation };
