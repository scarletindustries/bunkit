// Window chrome for macOS 26: SF Symbols, the toolbar, a split view with a sidebar and an
// inspector, Liquid Glass, and popovers.
//
// Everything here is AppKit's own: the toolbar draws the system's glass, the sidebar floats
// and the inspector sits edge to edge because NSSplitViewController makes them so, and the
// content runs under both when it is asked to. The wrappers only turn AppKit's
// delegate-and-controller shapes into objects you build once and hold.
import { createDelegate, globalObject, objc, str } from "../objc.ts";
import { ACTION_SELECTOR, actionTarget, toNSColor, View, type ViewOptions } from "./view.ts";
import { Container } from "./layout.ts";
import type { Window } from "./window.ts";
import * as C from "../generated/constants.ts";

// ---------------------------------------------------------------------------
// SF Symbols
// ---------------------------------------------------------------------------

/** A symbol's weight, as `NSFont.Weight` names it. */
export type SymbolWeight = "ultralight" | "thin" | "light" | "regular" | "medium" | "semibold" | "bold" | "heavy" | "black";

const SYMBOL_WEIGHTS: Record<SymbolWeight, number> = {
  ultralight: -0.8,
  thin: -0.6,
  light: -0.4,
  regular: 0,
  medium: 0.23,
  semibold: 0.3,
  bold: 0.4,
  heavy: 0.56,
  black: 0.62,
};

/** How {@link symbol} draws a symbol. */
export interface SymbolOptions {
  /** Point size. Omitted, the symbol takes the size of wherever it is placed. */
  size?: number;
  weight?: SymbolWeight;
  /** What VoiceOver says. Defaults to the symbol's name. */
  description?: string;
}

/**
 * An SF Symbol as an `NSImage`, or `null` when this system has no symbol by that name.
 *
 * `null` rather than a throw, because symbols are added every year and an app that runs on
 * more than one macOS should be able to ask. Side effect-free.
 */
export function symbol(name: string, options: SymbolOptions = {}): any {
  const image = objc.NSImage.imageWithSystemSymbolName_accessibilityDescription_(
    name, options.description ?? name,
  );
  if (!image || image.ptr === 0n) return null;
  if (options.size === undefined && options.weight === undefined) return image;
  const config = objc.NSImageSymbolConfiguration.configurationWithPointSize_weight_(
    options.size ?? 13, SYMBOL_WEIGHTS[options.weight ?? "regular"],
  );
  return image.imageWithSymbolConfiguration_(config);
}

/** An image view showing an SF Symbol, optionally tinted. */
export class SymbolView extends View {
  constructor(name: string, options: SymbolOptions & ViewOptions & { color?: any } = {}) {
    const view = objc.NSImageView.imageViewWithImage_(symbol(name, options) ?? objc.NSImage.alloc().init());
    super(view, options);
    if (options.color !== undefined) this.color = options.color;
    this.native.setContentHuggingPriority_forOrientation_(750, 0);
    this.native.setContentHuggingPriority_forOrientation_(750, 1);
  }

  /** Show a different symbol. */
  set name(name: string) {
    this.native.setImage_(symbol(name));
  }

  /** Tint it — a colour name, hex, or `NSColor`; `null` for the default. */
  set color(color: any) {
    this.native.setContentTintColor_(toNSColor(color));
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

/** How eagerly AppKit moves an item into the overflow menu as the window narrows. */
export type ToolbarVisibility = "low" | "standard" | "high" | "user";

const VISIBILITY: Record<ToolbarVisibility, number> = {
  low: C.NSToolbarItemVisibilityPriorityLow,
  standard: C.NSToolbarItemVisibilityPriorityStandard,
  high: C.NSToolbarItemVisibilityPriorityHigh,
  user: C.NSToolbarItemVisibilityPriorityUser,
};

interface ToolbarItemBase {
  /** Unique within the toolbar. */
  id: string;
  /** The item's name in the overflow menu and in customisation. */
  label: string;
  tooltip?: string;
  visibility?: ToolbarVisibility;
}

/** A button: a symbol, or a title, or both. */
export interface ToolbarButton extends ToolbarItemBase {
  kind: "button";
  symbol?: string;
  title?: string;
  onClick?: () => void;
  /** Draw it prominent — tinted glass of its own. See {@link ToolbarItem.prominent}. */
  prominent?: boolean;
  /** The prominent glass's colour. Defaults to the accent colour. */
  tint?: any;
}

/** A row of buttons on one piece of glass. */
export interface ToolbarGroup extends ToolbarItemBase {
  kind: "group";
  segments: { symbol?: string; title?: string; label: string; tooltip?: string }[];
  /**
   * `"one"` — a picker, one segment selected; `"any"` — toggles, each on or off;
   * `"momentary"` — buttons.
   */
  selection: "one" | "any" | "momentary";
  /** A segment was clicked. `selected` is the whole group's state after the click. */
  onSelect?: (index: number, selected: boolean[]) => void;
}

/** Any view, e.g. a status read-out. Non-interactive items should not be bordered. */
export interface ToolbarCustom extends ToolbarItemBase {
  kind: "view";
  view: View;
  /** Whether the item sits on glass. Default `false`: status is not a control. */
  bordered?: boolean;
}

export type ToolbarItemSpec = ToolbarButton | ToolbarGroup | ToolbarCustom;

/** AppKit's own items, and the separators that track a split view's dividers. */
export type ToolbarSystemItem =
  | "flexibleSpace"
  | "space"
  | "toggleSidebar"
  | "sidebarSeparator"
  | "toggleInspector"
  | "inspectorSeparator";

const SYSTEM_IDS: Record<ToolbarSystemItem, string> = {
  flexibleSpace: "NSToolbarFlexibleSpaceItemIdentifier",
  space: "NSToolbarSpaceItemIdentifier",
  toggleSidebar: "NSToolbarToggleSidebarItemIdentifier",
  sidebarSeparator: "NSToolbarSidebarTrackingSeparatorItemIdentifier",
  toggleInspector: "NSToolbarToggleInspectorItemIdentifier",
  inspectorSeparator: "NSToolbarInspectorTrackingSeparatorItemIdentifier",
};

/** Options for {@link Toolbar}. */
export interface ToolbarOptions {
  /** Identifies the toolbar to AppKit; two windows with one id share customisations. */
  id: string;
  /** In order, leading to trailing. */
  items: (ToolbarItemSpec | ToolbarSystemItem)[];
  /** Ids of items to keep centred in the window. */
  centered?: string[];
  /** Default `"icon"`. */
  display?: "icon" | "iconAndLabel" | "label";
}

/**
 * One item of a {@link Toolbar}, to change after it is built.
 *
 * Every setter writes only when the value changes, because a toolbar refreshed from a clock
 * mostly hears what it already shows, and AppKit relays out the toolbar on every write.
 */
export class ToolbarItem {
  readonly native: any;
  readonly spec: ToolbarItemSpec;
  #prominent = false;
  #tint: any = undefined;
  #badge: string | number | null = null;
  #title: string | undefined;
  #symbol: string | undefined;
  #enabled = true;
  #hidden = false;
  #tooltip: string | undefined;

  /** @internal */
  constructor(native: any, spec: ToolbarItemSpec) {
    this.native = native;
    this.spec = spec;
    if (spec.kind === "button") {
      this.#title = spec.title;
      this.#symbol = spec.symbol;
      this.#prominent = spec.prominent ?? false;
      this.#tint = spec.tint;
    }
    this.#tooltip = spec.tooltip;
  }

  /**
   * Whether the item is drawn **prominent**: tinted glass of its own, which the HIG reserves
   * for the one primary action or for "displaying state". Toggling it at runtime is how a
   * toolbar button shows a state as loudly as AppKit allows.
   */
  get prominent(): boolean {
    return this.#prominent;
  }
  set prominent(on: boolean) {
    if (on === this.#prominent) return;
    this.#prominent = on;
    this.native.setStyle_(on ? C.NSToolbarItemStyleProminent : C.NSToolbarItemStylePlain);
  }

  /** The prominent glass's colour; `null` for the accent colour. */
  set tint(color: any) {
    if (color === this.#tint) return;
    this.#tint = color;
    this.native.setBackgroundTintColor_(toNSColor(color));
  }

  /** A button's title. */
  get title(): string | undefined {
    return this.#title;
  }
  set title(title: string | undefined) {
    if (title === this.#title) return;
    this.#title = title;
    this.native.setTitle_(title ?? "");
  }

  /** A button's symbol. */
  set symbol(name: string | undefined) {
    if (name === this.#symbol) return;
    this.#symbol = name;
    this.native.setImage_(name ? symbol(name) : null);
  }

  get enabled(): boolean {
    return this.#enabled;
  }
  set enabled(on: boolean) {
    if (on === this.#enabled) return;
    this.#enabled = on;
    this.native.setEnabled_(on);
    if (this.spec.kind === "group") {
      const subitems = this.native.subitems();
      for (let i = 0; i < Number(subitems.count()); i++) subitems.objectAtIndex_(i).setEnabled_(on);
    }
  }

  /** Take the item out of the toolbar without removing it — it keeps its place. */
  get hidden(): boolean {
    return this.#hidden;
  }
  set hidden(on: boolean) {
    if (on === this.#hidden) return;
    this.#hidden = on;
    this.native.setHidden_(on);
  }

  set tooltip(text: string | undefined) {
    if (text === this.#tooltip) return;
    this.#tooltip = text;
    this.native.setToolTip_(text ?? "");
  }

  /**
   * A badge on the item: a count, a short text, `"indicator"` for a dot, or `null` for none.
   * For status a person should notice, such as problems behind a closed inspector.
   */
  get badge(): string | number | null {
    return this.#badge;
  }
  set badge(value: string | number | null) {
    if (value === this.#badge) return;
    this.#badge = value;
    const badge =
      value === null ? null
      : value === "indicator" ? objc.NSItemBadge.indicatorBadge()
      : typeof value === "number" ? objc.NSItemBadge.badgeWithCount_(value)
      : objc.NSItemBadge.badgeWithText_(value);
    this.native.setBadge_(badge);
  }

  /** A group's selection, one flag per segment. */
  get selected(): boolean[] {
    if (this.spec.kind !== "group") return [];
    return this.spec.segments.map((_, i) => Boolean(this.native.isSelectedAtIndex_(i)));
  }

  /** Select or deselect one segment of a group. */
  select(index: number, on = true): void {
    if (this.spec.kind !== "group") return;
    if (Boolean(this.native.isSelectedAtIndex_(index)) === on) return;
    this.native.setSelected_atIndex_(on, index);
  }

  /** Enable or disable one segment of a group. */
  enableSegment(index: number, on: boolean): void {
    if (this.spec.kind !== "group") return;
    const sub = this.native.subitems().objectAtIndex_(index);
    if (Boolean(sub.isEnabled()) !== on) sub.setEnabled_(on);
  }

  /** Change one segment's symbol and label — a Play that becomes Pause. */
  setSegment(index: number, segment: { symbol?: string; label?: string; tooltip?: string }): void {
    if (this.spec.kind !== "group") return;
    const current = this.spec.segments[index];
    if (!current) return;
    const sub = this.native.subitems().objectAtIndex_(index);
    if (segment.symbol !== undefined && segment.symbol !== current.symbol) {
      current.symbol = segment.symbol;
      sub.setImage_(symbol(segment.symbol));
    }
    if (segment.label !== undefined && segment.label !== current.label) {
      current.label = segment.label;
      sub.setLabel_(segment.label);
    }
    if (segment.tooltip !== undefined && segment.tooltip !== current.tooltip) {
      current.tooltip = segment.tooltip;
      sub.setToolTip_(segment.tooltip);
    }
  }

  /** Fire the item as though it were clicked — for tests and for menu items that mirror it. */
  click(index = 0): void {
    if (this.spec.kind === "button") this.spec.onClick?.();
    else if (this.spec.kind === "group") {
      if (this.spec.selection === "one") this.select(index, true);
      else if (this.spec.selection === "any") this.select(index, !this.selected[index]);
      this.spec.onSelect?.(index, this.selected);
    }
  }
}

/**
 * An `NSToolbar` built from a list: buttons, groups and views, in order, between AppKit's own
 * spaces and tracking separators.
 *
 * The items are made once, up front, and the delegate hands AppKit the same objects every
 * time it asks — so {@link item} is a stable handle for changing them later.
 */
export class Toolbar {
  readonly native: any;
  readonly #items = new Map<string, ToolbarItem>();
  readonly #order: string[] = [];
  readonly #delegate: any;
  readonly #keep: any[] = [];

  constructor(options: ToolbarOptions) {
    for (const entry of options.items) {
      if (typeof entry === "string") {
        this.#order.push(str(globalObject(SYSTEM_IDS[entry])));
        continue;
      }
      if (this.#items.has(entry.id)) throw new Error(`toolbar item "${entry.id}" appears twice`);
      this.#items.set(entry.id, this.#build(entry));
      this.#order.push(entry.id);
    }
    const ids = () => {
      const list = objc.NSMutableArray.array();
      for (const id of this.#order) list.addObject_(id);
      return list;
    };
    this.#delegate = createDelegate(
      {
        toolbarDefaultItemIdentifiers_: () => ids(),
        toolbarAllowedItemIdentifiers_: () => ids(),
        toolbar_itemForItemIdentifier_willBeInsertedIntoToolbar_: (_t: any, id: any) =>
          this.#items.get(str(id))?.native ?? null,
      },
      { protocols: ["NSToolbarDelegate"], name: "Toolbar" },
    );
    this.native = objc.NSToolbar.alloc().initWithIdentifier_(options.id);
    this.native.setDelegate_(this.#delegate);
    this.native.setDisplayMode_(
      options.display === "iconAndLabel" ? 1 : options.display === "label" ? 3 : 2,
    );
    if (options.centered?.length) {
      const set = objc.NSMutableSet.set();
      for (const id of options.centered) set.addObject_(id);
      this.native.setCenteredItemIdentifiers_(set);
    }
  }

  /** The item with this id. Throws for an id the toolbar was not built with. */
  item(id: string): ToolbarItem {
    const found = this.#items.get(id);
    if (!found) throw new Error(`no toolbar item "${id}"`);
    return found;
  }

  /** Whether the toolbar was built with an item of this id. */
  has(id: string): boolean {
    return this.#items.has(id);
  }

  /** Put the toolbar on a window. Side effect: replaces any toolbar it had. */
  attach(window: Window | any): void {
    const native = (window as Window).native ?? window;
    native.setToolbar_(this.native);
  }

  #build(spec: ToolbarItemSpec): ToolbarItem {
    let native: any;
    // Assigned last; the group's action reads it when clicked, long after construction.
    let handle: ToolbarItem | undefined;
    if (spec.kind === "group") {
      const images = objc.NSMutableArray.array();
      const labels = objc.NSMutableArray.array();
      for (const s of spec.segments) {
        images.addObject_(s.symbol ? (symbol(s.symbol) ?? objc.NSImage.alloc().init()) : objc.NSImage.alloc().init());
        labels.addObject_(s.label);
      }
      const mode =
        spec.selection === "one" ? C.NSToolbarItemGroupSelectionModeSelectOne
        : spec.selection === "any" ? C.NSToolbarItemGroupSelectionModeSelectAny
        : C.NSToolbarItemGroupSelectionModeMomentary;
      const target = actionTarget(() => {
        if (!handle || spec.kind !== "group") return;
        const index = Number(handle.native.selectedIndex());
        spec.onSelect?.(index, handle.selected);
      });
      this.#keep.push(target);
      native = objc.NSToolbarItemGroup.groupWithItemIdentifier_images_selectionMode_labels_target_action_(
        spec.id, images, mode, labels, target, ACTION_SELECTOR,
      );
      // Expanded, always: a group that folds into a pull-down when space is short hides the
      // very controls it exists to keep one click away.
      native.setControlRepresentation_(C.NSToolbarItemGroupControlRepresentationExpanded);
      const subitems = native.subitems();
      spec.segments.forEach((s, i) => {
        const sub = subitems.objectAtIndex_(i);
        if (s.tooltip) sub.setToolTip_(s.tooltip);
        if (s.title && !s.symbol) sub.setTitle_(s.title);
      });
      native.setLabel_(spec.label);
    } else {
      native = objc.NSToolbarItem.alloc().initWithItemIdentifier_(spec.id);
      native.setLabel_(spec.label);
      if (spec.kind === "button") {
        if (spec.symbol) native.setImage_(symbol(spec.symbol));
        if (spec.title) native.setTitle_(spec.title);
        const target = actionTarget(() => spec.onClick?.());
        this.#keep.push(target);
        native.setTarget_(target);
        native.setAction_(ACTION_SELECTOR);
        if (spec.prominent) native.setStyle_(C.NSToolbarItemStyleProminent);
        if (spec.tint !== undefined) native.setBackgroundTintColor_(toNSColor(spec.tint));
      } else {
        native.setView_(spec.view.native);
        native.setBordered_(spec.bordered ?? false);
        this.#keep.push(spec.view);
      }
    }
    if (spec.tooltip) native.setToolTip_(spec.tooltip);
    if (spec.visibility) native.setVisibilityPriority_(VISIBILITY[spec.visibility]);
    handle = new ToolbarItem(native, spec);
    return handle;
  }
}

// ---------------------------------------------------------------------------
// Split layout: sidebar, content, inspector
// ---------------------------------------------------------------------------

/** A pane's width, in points. A fixed width is `{ min: w, max: w }`. */
export interface PaneWidth {
  min?: number;
  max?: number;
  /** Start collapsed. */
  collapsed?: boolean;
}

/** Options for {@link SplitLayout}. */
export interface SplitLayoutOptions {
  /** The leading pane: navigation. Floats as glass over the content on macOS 26. */
  sidebar?: { view: View } & PaneWidth;
  /** The middle. Runs under the sidebar, the inspector and the toolbar. */
  content: View;
  /** The trailing pane: details. Edge-to-edge glass beside the content. */
  inspector?: { view: View } & PaneWidth;
  /** A strip pinned to the top of the content pane, under the toolbar. */
  contentAccessory?: View;
}

/**
 * An `NSSplitViewController` with the panes macOS draws natively: a **sidebar** on the leading
 * edge, the **content**, and an **inspector** on the trailing edge.
 *
 * The content's split item adjusts its safe area rather than its frame, so the content view
 * runs under the toolbar and the inspector, and anything placed against its
 * `safeAreaLayoutGuide` stays clear of them. Each pane's view is held in a container, so a
 * pane's contents can be swapped ({@link setContent}) without rebuilding the controller.
 */
export class SplitLayout {
  readonly controller: any;
  readonly sidebarItem: any | undefined;
  readonly contentItem: any;
  readonly inspectorItem: any | undefined;
  /** The containers each pane's view sits in. */
  readonly sidebarHost: Container | undefined;
  readonly contentHost: Container;
  readonly inspectorHost: Container | undefined;
  #content: View;
  #accessory: { view: View; controller: any } | undefined;
  readonly #keep: any[] = [];

  constructor(options: SplitLayoutOptions) {
    this.controller = objc.NSSplitViewController.alloc().init();
    const pane = (view: View): { host: Container; vc: any } => {
      const host = new Container();
      host.fill(view);
      const vc = objc.NSViewController.alloc().init();
      vc.setView_(host.native);
      this.#keep.push(vc, host);
      return { host, vc };
    };
    if (options.sidebar) {
      const { host, vc } = pane(options.sidebar.view);
      this.sidebarHost = host;
      this.sidebarItem = objc.NSSplitViewItem.sidebarWithViewController_(vc);
      applyWidth(this.sidebarItem, options.sidebar);
      this.controller.addSplitViewItem_(this.sidebarItem);
    }
    const content = pane(options.content);
    this.contentHost = content.host;
    this.#content = options.content;
    this.contentItem = objc.NSSplitViewItem.splitViewItemWithViewController_(content.vc);
    this.contentItem.setAutomaticallyAdjustsSafeAreaInsets_(true);
    this.controller.addSplitViewItem_(this.contentItem);
    if (options.inspector) {
      const { host, vc } = pane(options.inspector.view);
      this.inspectorHost = host;
      this.inspectorItem = objc.NSSplitViewItem.inspectorWithViewController_(vc);
      applyWidth(this.inspectorItem, options.inspector);
      this.controller.addSplitViewItem_(this.inspectorItem);
    }
    if (options.contentAccessory) this.contentAccessory = options.contentAccessory;
  }

  /** What the content pane shows. */
  get content(): View {
    return this.#content;
  }

  /** Show something else in the content pane — a different mode. The old view is kept alive by the caller. */
  setContent(view: View): void {
    if (view === this.#content) return;
    this.#content.removeFromParent();
    this.contentHost.fill(view);
    this.#content = view;
  }

  /** The strip pinned to the top of the content pane, or `undefined` for none. */
  get contentAccessory(): View | undefined {
    return this.#accessory?.view;
  }
  set contentAccessory(view: View | undefined) {
    if (view === this.#accessory?.view) return;
    if (this.#accessory) {
      const list = this.contentItem.topAlignedAccessoryViewControllers();
      for (let i = Number(list.count()) - 1; i >= 0; i--) {
        if (list.objectAtIndex_(i).ptr === this.#accessory.controller.ptr) {
          this.contentItem.removeTopAlignedAccessoryViewControllerAtIndex_(i);
        }
      }
      this.#accessory = undefined;
    }
    if (!view) return;
    const controller = objc.NSSplitViewItemAccessoryViewController.alloc().init();
    controller.setView_(view.native);
    this.#keep.push(controller, view);
    this.contentItem.addTopAlignedAccessoryViewController_(controller);
    this.#accessory = { view, controller };
  }

  /** Whether the sidebar is collapsed. Setting it animates, as the toolbar button does. */
  get sidebarCollapsed(): boolean {
    return this.sidebarItem ? Boolean(this.sidebarItem.isCollapsed()) : true;
  }
  set sidebarCollapsed(on: boolean) {
    if (!this.sidebarItem || on === this.sidebarCollapsed) return;
    this.sidebarItem.setCollapsed_(on);
  }

  /** Whether the inspector is collapsed. */
  get inspectorCollapsed(): boolean {
    return this.inspectorItem ? Boolean(this.inspectorItem.isCollapsed()) : true;
  }
  set inspectorCollapsed(on: boolean) {
    if (!this.inspectorItem || on === this.inspectorCollapsed) return;
    this.inspectorItem.setCollapsed_(on);
  }

  /** Give the inspector a new width — wider for a page that needs it. */
  setInspectorWidth(width: PaneWidth): void {
    if (this.inspectorItem) applyWidth(this.inspectorItem, width);
  }

  /**
   * Make this the window's content. Side effects: replaces the window's content view, and
   * keeps the window's frame — a content view controller otherwise resizes its window to fit.
   */
  attach(window: Window | any): void {
    const native = (window as Window).native ?? window;
    const frame = native.frame();
    native.setContentViewController_(this.controller);
    native.setFrame_display_(frame, true);
  }
}

function applyWidth(item: any, width: PaneWidth): void {
  if (width.min !== undefined) item.setMinimumThickness_(width.min);
  if (width.max !== undefined) item.setMaximumThickness_(width.max);
  if (width.collapsed !== undefined) item.setCollapsed_(width.collapsed);
}

// ---------------------------------------------------------------------------
// Liquid Glass
// ---------------------------------------------------------------------------

/** Options for {@link GlassView}. */
export interface GlassOptions extends ViewOptions {
  /** Corner radius. Omitted, AppKit's own. */
  radius?: number;
  /** A colour washed into the glass. Use for one thing at most. */
  tint?: any;
  /** `"clear"` only over bright, busy media, and only with bold content on top. */
  style?: "regular" | "clear";
  /** Space between the glass's edge and its content, in points. Default 12. */
  padding?: number | { top?: number; left?: number; bottom?: number; right?: number };
}

/**
 * An `NSGlassEffectView` around one view: Liquid Glass for a control floating over content.
 *
 * The HIG keeps glass to the control layer: floating controls and status over media, never
 * the content itself, and never glass on glass.
 */
export class GlassView extends View {
  readonly #host: Container;
  #content: View | undefined;

  constructor(content: View | undefined, options: GlassOptions = {}) {
    const glass = objc.NSGlassEffectView.alloc().init();
    super(glass, options);
    if (options.radius !== undefined) glass.setCornerRadius_(options.radius);
    if (options.tint !== undefined) glass.setTintColor_(toNSColor(options.tint));
    if (options.style === "clear") glass.setStyle_(C.NSGlassEffectViewStyleClear);
    this.#host = new Container();
    glass.setContentView_(this.#host.native);
    this.retainJS(this.#host);
    const p = options.padding ?? 12;
    this.#pad = typeof p === "number" ? { top: p, left: p, bottom: p, right: p } : { top: 12, left: 12, bottom: 12, right: 12, ...p };
    if (content) this.content = content;
  }

  readonly #pad: { top: number; left: number; bottom: number; right: number };

  get content(): View | undefined {
    return this.#content;
  }
  /** Replace what sits in the glass. */
  set content(view: View | undefined) {
    this.#content?.removeFromParent();
    this.#content = view;
    if (!view) return;
    this.#host.add(view);
    const pin = (a: number, constant: number) => {
      const c = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(
        view.native, a, 0, this.#host.native, a, 1.0, constant,
      );
      c.setActive_(true);
      this.retainJS(c);
    };
    pin(C.NSLayoutAttributeLeading, this.#pad.left);
    pin(C.NSLayoutAttributeTop, this.#pad.top);
    pin(C.NSLayoutAttributeTrailing, -this.#pad.right);
    pin(C.NSLayoutAttributeBottom, -this.#pad.bottom);
  }

  /** Tint the glass; `null` for none. */
  set tint(color: any) {
    this.native.setTintColor_(toNSColor(color));
  }
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

/** Options for {@link Popover}. */
export interface PopoverOptions {
  content: View;
  /** `"transient"` closes on any click outside; `"semitransient"` survives clicks in the window. */
  behavior?: "transient" | "semitransient" | "manual";
  /** Called once it has closed. */
  onClose?: () => void;
}

/**
 * An `NSPopover` holding one view — for simple adjustment controls next to the thing that
 * opened them. Never for a warning: the HIG is explicit that a popover is not where one goes.
 */
export class Popover {
  readonly native: any;
  readonly content: View;
  readonly #delegate: any;
  readonly #keep: any[] = [];

  constructor(options: PopoverOptions) {
    this.content = options.content;
    const vc = objc.NSViewController.alloc().init();
    vc.setView_(options.content.native);
    this.native = objc.NSPopover.alloc().init();
    this.native.setContentViewController_(vc);
    this.native.setBehavior_(
      options.behavior === "semitransient" ? C.NSPopoverBehaviorSemitransient
      : options.behavior === "manual" ? C.NSPopoverBehaviorApplicationDefined
      : C.NSPopoverBehaviorTransient,
    );
    this.#delegate = createDelegate(
      { popoverDidClose_: () => options.onClose?.() },
      { protocols: ["NSPopoverDelegate"], name: "Popover" },
    );
    this.native.setDelegate_(this.#delegate);
    this.#keep.push(vc, options.content);
  }

  /** Whether it is on screen. */
  get shown(): boolean {
    return Boolean(this.native.isShown());
  }

  /** Open it pointing at a toolbar item. */
  showFromToolbarItem(item: ToolbarItem): void {
    this.native.showRelativeToToolbarItem_(item.native);
  }

  /** Open it pointing at a view, from the given edge of it. */
  showFrom(view: View, edge: "top" | "bottom" | "leading" | "trailing" = "bottom"): void {
    const e =
      edge === "top" ? C.NSRectEdgeMaxY
      : edge === "bottom" ? C.NSRectEdgeMinY
      : edge === "leading" ? C.NSRectEdgeMinX
      : C.NSRectEdgeMaxX;
    this.native.showRelativeToRect_ofView_preferredEdge_(view.native.bounds(), view.native, e);
  }

  /** Open it if closed, close it if open. */
  toggleFromToolbarItem(item: ToolbarItem): void {
    if (this.shown) this.close();
    else this.showFromToolbarItem(item);
  }

  /** Close it, at once — no fade, so the next line can count on it being gone. */
  close(): void {
    if (!this.shown) return;
    const animates = Boolean(this.native.animates());
    this.native.setAnimates_(false);
    this.native.close();
    this.native.setAnimates_(animates);
  }
}
