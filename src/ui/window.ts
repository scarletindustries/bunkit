// Window — an NSWindow with the delegate machinery hidden behind callbacks.

import { createDelegate, objc, str } from "../objc.ts";
import { initApp, quit as runtimeQuit } from "../runtime.ts";
import { View, toNSColor } from "./view.ts";
import { Container } from "./layout.ts";
import {
  BackingStore,
  WindowCollectionBehavior,
  WindowStyleMask,
  WindowTitleVisibility,
} from "./appkit.ts";
import type { CGRect, CGSize } from "../structs.ts";

export interface WindowOptions {
  title?: string;
  size?: CGSize | { width: number; height: number };
  minSize?: { width: number; height: number };
  maxSize?: { width: number; height: number };
  /** Screen position of the bottom-left corner; omitted means centred. */
  position?: { x: number; y: number };
  resizable?: boolean;
  closable?: boolean;
  minimizable?: boolean;
  /** Draw content behind a transparent titlebar. */
  fullSizeContent?: boolean;
  titleVisible?: boolean;
  /** Colour or "#rrggbb" for the window background. */
  background?: any;
  /** Restore/save the frame under this name across launches. */
  autosaveName?: string;
  onClose?: (w: Window) => void;
  /** Return false to veto a close. */
  shouldClose?: (w: Window) => boolean;
  onResize?: (size: CGSize, w: Window) => void;
  onMove?: (origin: { x: number; y: number }, w: Window) => void;
  onFocus?: (w: Window) => void;
  onBlur?: (w: Window) => void;
  content?: View;
  /** A second line under the title (macOS 11+): the window's state, in a few words. */
  subtitle?: string;
  /**
   * How the title bar and toolbar share the top of the window. `"unified"` puts the title
   * inline with a toolbar; `"expanded"` gives the title a row of its own.
   */
  toolbarStyle?: "automatic" | "expanded" | "unified" | "unifiedCompact";
  /** Force an appearance; omitted, the window follows the system. */
  appearance?: "dark" | "light";
  /** Show the window as soon as it is constructed. Default true. */
  show?: boolean;
}

const openWindows = new Set<Window>();

export class Window {
  readonly native: any;
  #root!: Container;
  #content: View | null = null;
  #delegate: any;
  #closed = false;
  #handlers: WindowOptions;

  constructor(options: WindowOptions = {}) {
    initApp();
    this.#handlers = options;

    const size = options.size ?? { width: 720, height: 480 };
    let mask = WindowStyleMask.Titled;
    if (options.closable !== false) mask |= WindowStyleMask.Closable;
    if (options.minimizable !== false) mask |= WindowStyleMask.Miniaturizable;
    if (options.resizable !== false) mask |= WindowStyleMask.Resizable;
    if (options.fullSizeContent) mask |= WindowStyleMask.FullSizeContentView;

    const rect: CGRect = {
      x: options.position?.x ?? 0,
      y: options.position?.y ?? 0,
      width: size.width,
      height: size.height,
    };

    this.native = objc.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
      rect, mask, BackingStore.Buffered, false,
    );
    // We manage the window's lifetime from JS; letting AppKit release it on
    // close would leave our wrapper pointing at freed memory.
    this.native.setReleasedWhenClosed_(false);

    if (options.title !== undefined) this.native.setTitle_(options.title);
    if (options.subtitle !== undefined) this.native.setSubtitle_(options.subtitle);
    if (options.toolbarStyle !== undefined) {
      this.native.setToolbarStyle_(
        { automatic: 0, expanded: 1, unified: 3, unifiedCompact: 4 }[options.toolbarStyle],
      );
    }
    if (options.appearance !== undefined) {
      this.native.setAppearance_(objc.NSAppearance.appearanceNamed_(
        options.appearance === "dark" ? "NSAppearanceNameDarkAqua" : "NSAppearanceNameAqua",
      ));
    }
    if (options.minSize) this.native.setMinSize_(options.minSize);
    if (options.maxSize) this.native.setMaxSize_(options.maxSize);
    if (options.fullSizeContent) {
      this.native.setTitlebarAppearsTransparent_(true);
      this.native.setTitleVisibility_(
        options.titleVisible === false ? WindowTitleVisibility.Hidden : WindowTitleVisibility.Visible,
      );
    }
    if (options.background !== undefined) {
      this.native.setBackgroundColor_(toNSColor(options.background));
    }
    this.native.setCollectionBehavior_(WindowCollectionBehavior.FullScreenPrimary);

    // A plain container is always installed so `window.content = view` can pin
    // its child with constraints regardless of what AppKit hands us.
    const root = new Container();
    // The root view draws nothing by default, which leaves snapshots (and
    // vibrancy compositing) with a transparent hole where the window's own
    // background should be.
    if (options.background !== "clear") {
      root.setBackground(options.background ?? "windowBackground");
    }
    this.native.setContentView_(root.native);
    this.#root = root;

    this.installDelegate();

    if (options.content) this.content = options.content;
    if (options.position === undefined) this.center();
    if (options.autosaveName) this.native.setFrameAutosaveName_(options.autosaveName);
    if (options.show !== false) this.show();
    openWindows.add(this);
  }

  private installDelegate() {
    this.#delegate = createDelegate(
      {
        windowWillClose_: () => {
          this.#closed = true;
          openWindows.delete(this);
          this.#handlers.onClose?.(this);
        },
        windowShouldClose_: () => this.#handlers.shouldClose?.(this) ?? true,
        windowDidResize_: () => this.#handlers.onResize?.(this.size, this),
        windowDidMove_: () => this.#handlers.onMove?.(this.position, this),
        windowDidBecomeKey_: () => this.#handlers.onFocus?.(this),
        windowDidResignKey_: () => this.#handlers.onBlur?.(this),
      },
      { protocols: ["NSWindowDelegate"], name: "Window" },
    );
    this.native.setDelegate_(this.#delegate);
  }

  // --- title -------------------------------------------------------------------

  /** The second line under the title. Writing the same text again does nothing. */
  get subtitle(): string {
    return str(this.native.subtitle());
  }
  set subtitle(text: string) {
    if (text === this.#subtitle) return;
    this.#subtitle = text;
    this.native.setSubtitle_(text);
  }
  #subtitle: string | undefined;

  // --- content -------------------------------------------------------------

  get content(): View | null {
    return this.#content;
  }

  set content(v: View | null) {
    if (this.#content) this.#content.removeFromParent();
    this.#content = v;
    if (v) this.#root.fill(v);
  }

  /** The always-present root container; use it for absolute positioning. */
  get root(): Container {
    return this.#root;
  }

  // --- properties ----------------------------------------------------------

  get title(): string {
    return str(this.native.title());
  }

  set title(v: string) {
    this.native.setTitle_(v);
  }

  get size(): CGSize {
    const f = this.native.contentView().frame();
    return { width: f.width, height: f.height };
  }

  set size(s: { width: number; height: number }) {
    this.native.setContentSize_(s);
  }

  get position(): { x: number; y: number } {
    const f = this.native.frame();
    return { x: f.x, y: f.y };
  }

  set position(p: { x: number; y: number }) {
    this.native.setFrameOrigin_(p);
  }

  get frame(): CGRect {
    return this.native.frame();
  }

  get isVisible(): boolean {
    return this.native.isVisible();
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // --- actions -------------------------------------------------------------

  show(): this {
    this.native.makeKeyAndOrderFront_(null);
    objc.NSApplication.sharedApplication().activateIgnoringOtherApps_(true);
    return this;
  }

  hide(): this {
    this.native.orderOut_(null);
    return this;
  }

  center(): this {
    this.native.center();
    return this;
  }

  close(): void {
    this.native.close();
  }

  focus(): this {
    this.native.makeKeyAndOrderFront_(null);
    return this;
  }

  toggleFullScreen(): void {
    this.native.toggleFullScreen_(null);
  }

  /** Resize the window to exactly fit its content's constraints. */
  sizeToFit(): this {
    const fitting = this.#root.native.fittingSize();
    if (fitting.width > 0 && fitting.height > 0) this.native.setContentSize_(fitting);
    return this;
  }

  // --- events --------------------------------------------------------------

  onClose(fn: (w: Window) => void): this {
    this.#handlers.onClose = fn;
    return this;
  }

  onResize(fn: (size: CGSize, w: Window) => void): this {
    this.#handlers.onResize = fn;
    return this;
  }

  /** Close this window and quit the app when it goes. */
  quitOnClose(): this {
    const prev = this.#handlers.onClose;
    this.#handlers.onClose = (w) => {
      prev?.(w);
      runtimeQuit();
    };
    return this;
  }
}

export function allWindows(): Window[] {
  return [...openWindows];
}
