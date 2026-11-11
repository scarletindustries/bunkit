// Menus. A macOS app without a proper menu bar feels broken, so `standardMenu()`
// builds the conventional one and you add your own items to it.

import { objc, str } from "../objc.ts";
import { quit as runtimeQuit } from "../runtime.ts";
import { ACTION_SELECTOR, actionTarget } from "./view.ts";
import { EventModifierFlags } from "./appkit.ts";

export interface MenuItemSpec {
  title: string;
  /** "cmd+s", "cmd+shift+n", "alt+f4" — modifiers joined by "+". */
  shortcut?: string;
  onClick?: (item: any) => void;
  /** A built-in AppKit selector such as "copy:" — sent to the first responder. */
  action?: string;
  enabled?: boolean;
  checked?: boolean;
  submenu?: MenuItemSpec[];
  /** A horizontal rule. */
  separator?: boolean;
  /** AppKit's own services/windows menus. */
  role?: "services" | "windows" | "help";
}

const MODIFIERS: Record<string, number> = {
  cmd: EventModifierFlags.Command,
  command: EventModifierFlags.Command,
  meta: EventModifierFlags.Command,
  shift: EventModifierFlags.Shift,
  alt: EventModifierFlags.Option,
  option: EventModifierFlags.Option,
  ctrl: EventModifierFlags.Control,
  control: EventModifierFlags.Control,
};

const SPECIAL_KEYS: Record<string, string> = {
  delete: "",
  backspace: "",
  enter: "\r",
  return: "\r",
  tab: "\t",
  escape: "",
  esc: "",
  space: " ",
  up: "",
  down: "",
  left: "",
  right: "",
};

function parseShortcut(s: string): { key: string; mask: number } {
  const parts = s.split("+").map((p) => p.trim().toLowerCase());
  let mask = 0;
  let key = "";
  for (const p of parts) {
    if (MODIFIERS[p] !== undefined) mask |= MODIFIERS[p]!;
    else key = SPECIAL_KEYS[p] ?? p;
  }
  // An uppercase key equivalent implies Shift to AppKit, so keep it lowercase
  // and express Shift through the mask.
  return { key: key.length === 1 ? key.toLowerCase() : key, mask };
}

// Menu items hold only a weak reference to their target, so every action target
// we mint has to be kept alive for the life of the process.
const menuTargets: any[] = [];

export class Menu {
  readonly native: any;

  constructor(title = "") {
    this.native = objc.NSMenu.alloc().initWithTitle_(title);
    this.native.setAutoenablesItems_(false);
  }

  static from(items: MenuItemSpec[], title = ""): Menu {
    const m = new Menu(title);
    for (const i of items) m.add(i);
    return m;
  }

  add(spec: MenuItemSpec): any {
    if (spec.separator) {
      const sep = objc.NSMenuItem.separatorItem();
      this.native.addItem_(sep);
      return sep;
    }

    const { key, mask } = spec.shortcut ? parseShortcut(spec.shortcut) : { key: "", mask: 0 };
    const item = objc.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
      spec.title, null, key,
    );
    if (mask) item.setKeyEquivalentModifierMask_(mask);

    if (spec.onClick) {
      const t = actionTarget(() => spec.onClick!(item));
      menuTargets.push(t);
      item.setTarget_(t);
      item.setAction_(ACTION_SELECTOR);
    } else if (spec.action) {
      // nil target means "send up the responder chain", which is how Cut/Copy/
      // Paste and friends are supposed to work.
      item.setAction_(spec.action);
      item.setTarget_(null);
    }

    item.setEnabled_(spec.enabled !== false);
    if (spec.checked !== undefined) item.setState_(spec.checked ? 1 : 0);

    if (spec.submenu) {
      const sub = Menu.from(spec.submenu, spec.title);
      item.setSubmenu_(sub.native);
      if (spec.role === "services") objc.NSApplication.sharedApplication().setServicesMenu_(sub.native);
      if (spec.role === "windows") objc.NSApplication.sharedApplication().setWindowsMenu_(sub.native);
      if (spec.role === "help") objc.NSApplication.sharedApplication().setHelpMenu_(sub.native);
    }

    this.native.addItem_(item);
    return item;
  }

  addSubmenu(title: string, items: MenuItemSpec[]): Menu {
    const sub = Menu.from(items, title);
    const item = objc.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, null, "");
    item.setSubmenu_(sub.native);
    this.native.addItem_(item);
    return sub;
  }

  get itemCount(): number {
    return Number(this.native.numberOfItems());
  }
}

export interface StandardMenuOptions {
  /** The name in About, Hide and Quit. Default: the bundle's display name ({@link bundledAppName}), else the process's. */
  appName?: string;
  about?: boolean | (() => void);
  preferences?: () => void;
  /** Extra top-level menus appended after Edit. */
  menus?: Array<{ title: string; items: MenuItemSpec[] }>;
  /** Items appended to the top of the File menu. If absent, no File menu. */
  file?: MenuItemSpec[];
  edit?: boolean;
  view?: MenuItemSpec[];
  window?: boolean;
  help?: MenuItemSpec[];
  onQuit?: () => void;
}

/**
 * Build and install the conventional macOS menu bar.
 * Quit routes through the runtime's quit() rather than -[NSApp terminate:], so
 * JS gets to unwind instead of being exit()'d out from under.
 */
/**
 * The app's name as people see it, when it is running from a bundled `.app`: the bundle's
 * `CFBundleDisplayName`, else its `CFBundleName`. `undefined` from source (`bun run`), where the
 * process is Bun and its name is not the app's.
 */
export function bundledAppName(): string | undefined {
  const bundle = objc.NSBundle.mainBundle();
  if (!bundle || bundle.ptr === 0n) return undefined;
  if (!str(bundle.bundlePath()).endsWith(".app")) return undefined;
  for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
    const value = bundle.objectForInfoDictionaryKey_(key);
    if (value && value.ptr !== 0n) {
      const name = str(value);
      if (name.length > 0) return name;
    }
  }
  return undefined;
}

export function standardMenu(options: StandardMenuOptions = {}): Menu {
  const app = objc.NSApplication.sharedApplication();
  const name = options.appName ?? bundledAppName() ?? str(objc.NSProcessInfo.processInfo().processName());
  const bar = new Menu("MainMenu");

  // --- application menu ----------------------------------------------------
  const appItems: MenuItemSpec[] = [];
  if (options.about !== false) {
    appItems.push({
      title: `About ${name}`,
      onClick: typeof options.about === "function"
        ? () => (options.about as () => void)()
        : () => app.orderFrontStandardAboutPanel_(null),
    });
    appItems.push({ separator: true, title: "" });
  }
  if (options.preferences) {
    appItems.push({ title: "Settings…", shortcut: "cmd+,", onClick: options.preferences });
    appItems.push({ separator: true, title: "" });
  }
  appItems.push({ title: "Services", submenu: [], role: "services" });
  appItems.push({ separator: true, title: "" });
  appItems.push({ title: `Hide ${name}`, shortcut: "cmd+h", action: "hide:" });
  appItems.push({ title: "Hide Others", shortcut: "cmd+alt+h", action: "hideOtherApplications:" });
  appItems.push({ title: "Show All", action: "unhideAllApplications:" });
  appItems.push({ separator: true, title: "" });
  appItems.push({
    title: `Quit ${name}`,
    shortcut: "cmd+q",
    onClick: () => {
      options.onQuit?.();
      runtimeQuit();
    },
  });
  bar.addSubmenu(name, appItems);

  // --- file ----------------------------------------------------------------
  if (options.file) bar.addSubmenu("File", options.file);

  // --- edit ----------------------------------------------------------------
  if (options.edit !== false) {
    bar.addSubmenu("Edit", [
      { title: "Undo", shortcut: "cmd+z", action: "undo:" },
      { title: "Redo", shortcut: "cmd+shift+z", action: "redo:" },
      { separator: true, title: "" },
      { title: "Cut", shortcut: "cmd+x", action: "cut:" },
      { title: "Copy", shortcut: "cmd+c", action: "copy:" },
      { title: "Paste", shortcut: "cmd+v", action: "paste:" },
      { title: "Delete", action: "delete:" },
      { title: "Select All", shortcut: "cmd+a", action: "selectAll:" },
    ]);
  }

  if (options.view) bar.addSubmenu("View", options.view);
  for (const m of options.menus ?? []) bar.addSubmenu(m.title, m.items);

  // --- window --------------------------------------------------------------
  if (options.window !== false) {
    const win = bar.addSubmenu("Window", [
      { title: "Minimize", shortcut: "cmd+m", action: "performMiniaturize:" },
      { title: "Zoom", action: "performZoom:" },
      { separator: true, title: "" },
      { title: "Bring All to Front", action: "arrangeInFront:" },
    ]);
    app.setWindowsMenu_(win.native);
  }

  if (options.help) {
    const help = bar.addSubmenu("Help", options.help);
    app.setHelpMenu_(help.native);
  }

  app.setMainMenu_(bar.native);
  return bar;
}

/** Show a context menu at the current mouse position. */
export function popUpMenu(items: MenuItemSpec[], view?: any): void {
  const m = Menu.from(items);
  const event = objc.NSApplication.sharedApplication().currentEvent();
  objc.NSMenu.popUpContextMenu_withEvent_forView_(m.native, event, view ?? null);
}
