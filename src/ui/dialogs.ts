// Dialogs — sheets only, never modal.
//
// -[NSApplication runModal*] spins a nested run loop that br_pump never returns
// from, which freezes all of JavaScript for as long as the dialog is up. Every
// dialog here uses the sheet variant, which runs in the ordinary run loop, and
// returns a promise. That single rule removes the largest category of freezes.

import { cfunction, createBlock, objc, str, tryClass } from "../objc.ts";
import { AlertStyle, ModalResponse } from "./appkit.ts";
import { nativeOf } from "./view.ts";
import type { Window } from "./window.ts";

/**
 * The window a sheet hangs from: the one given, or the key window, the main window, or the
 * first **visible** window — never one that has been closed. `windows` still lists a closed
 * window that something holds, and a sheet hung from it brings it back on screen, frozen on its
 * last frame. `undefined` when no window is on screen, and the caller hangs the sheet from a
 * transparent {@link hostWindow} instead.
 */
function nativeWindow(w?: Window | any): any {
  if (w) return nativeOf(w);
  const app = objc.NSApplication.sharedApplication();
  const shown = (candidate: any) =>
    candidate && candidate.ptr !== undefined && candidate.ptr !== 0n && Boolean(candidate.isVisible()) ? candidate : undefined;
  const key = shown(app.keyWindow());
  if (key) return key;
  const main = shown(app.mainWindow());
  if (main) return main;
  const list = app.windows();
  for (let i = 0; i < Number(list?.count?.() ?? 0); i++) {
    const candidate = shown(list.objectAtIndex_(i));
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * A window to hang a sheet from when none is on screen: a borderless, transparent panel in the
 * upper middle of the main screen, floating above other windows. The sheet drops from it like a
 * standalone alert would, but in the ordinary run loop — `runModal` would freeze every timer in
 * the process (a show's DMX clock included) for as long as the alert stayed up. Close it with
 * {@link closeHost} when the sheet ends.
 */
function hostWindow(): any {
  const screen = objc.NSScreen.mainScreen();
  const frame = screen ? screen.visibleFrame() : { x: 0, y: 0, width: 1440, height: 900 };
  const width = 460;
  const rect = {
    x: Number(frame.x) + (Number(frame.width) - width) / 2,
    y: Number(frame.y) + Number(frame.height) * 0.72,
    width,
    height: 1,
  };
  // Borderless (0), buffered backing (2).
  const panel = objc.NSPanel.alloc().initWithContentRect_styleMask_backing_defer_(rect, 0, 2, false);
  panel.setOpaque_(false);
  panel.setBackgroundColor_(objc.NSColor.clearColor());
  panel.setHasShadow_(false);
  panel.setReleasedWhenClosed_(false);
  // NSFloatingWindowLevel: above the app's other windows, as an alert would be.
  panel.setLevel_(3);
  panel.orderFrontRegardless();
  return panel;
}

/** Take a {@link hostWindow} away once its sheet has ended. */
function closeHost(host: any): void {
  try {
    host.orderOut_(null);
    host.close();
  } catch {
    // Already gone with the app.
  }
}

export interface AlertOptions {
  title: string;
  message?: string;
  /** Button titles, left to right. The first is the default. */
  buttons?: string[];
  style?: "warning" | "info" | "critical";
  window?: Window;
  /** Show a "Don't ask again" checkbox; the result includes its state. */
  suppressible?: boolean;
}

export interface AlertResult {
  /** Index into `buttons` of the one that was pressed. */
  button: number;
  title: string;
  suppressed: boolean;
}

/** Show an alert as a sheet. Resolves when the user dismisses it. */
export function alert(options: AlertOptions): Promise<AlertResult> {
  const a = objc.NSAlert.alloc().init();
  a.setMessageText_(options.title);
  if (options.message) a.setInformativeText_(options.message);
  a.setAlertStyle_(
    options.style === "critical" ? AlertStyle.Critical
    : options.style === "info" ? AlertStyle.Informational
    : AlertStyle.Warning,
  );
  const buttons = options.buttons ?? ["OK"];
  for (const b of buttons) a.addButtonWithTitle_(b);
  if (options.suppressible) a.setShowsSuppressionButton_(true);

  const parent = nativeWindow(options.window);
  // No window on screen: hang the alert from a transparent host instead — never runModal, which
  // would freeze all of JavaScript (a show's clock included) until someone clicked.
  const host = parent ? undefined : hostWindow();
  return new Promise<AlertResult>((resolve) => {
    // void (^)(NSModalResponse)  ->  NSModalResponse is NSInteger, "q"
    const handler = createBlock("v@?q", (response: number) => {
      if (host) closeHost(host);
      const idx = Number(response) - ModalResponse.AlertFirstButton;
      const suppressed = options.suppressible
        ? Number(a.suppressionButton()?.state() ?? 0) === 1
        : false;
      resolve({
        button: idx >= 0 && idx < buttons.length ? idx : 0,
        title: buttons[Math.max(0, Math.min(idx, buttons.length - 1))] ?? "",
        suppressed,
      });
      queueMicrotask(() => handler.dispose());
    });
    a.beginSheetModalForWindow_completionHandler_(parent ?? host, handler);
  });
}

/** Ask a yes/no question. Resolves true if the first button was chosen. */
export async function confirm(
  title: string,
  message?: string,
  opts: { confirmLabel?: string; cancelLabel?: string; window?: Window; destructive?: boolean } = {},
): Promise<boolean> {
  const r = await alert({
    title,
    message,
    buttons: [opts.confirmLabel ?? "OK", opts.cancelLabel ?? "Cancel"],
    style: opts.destructive ? "critical" : "warning",
    window: opts.window,
  });
  return r.button === 0;
}

export interface FileDialogOptions {
  title?: string;
  message?: string;
  /** File extensions without the dot, e.g. ["png", "jpg"]. */
  types?: string[];
  directory?: string;
  defaultName?: string;
  multiple?: boolean;
  chooseDirectories?: boolean;
  chooseFiles?: boolean;
  canCreateDirectories?: boolean;
  window?: Window;
}

function configurePanel(p: any, o: FileDialogOptions) {
  if (o.title) p.setTitle_(o.title);
  if (o.message) p.setMessage_(o.message);
  if (o.directory) p.setDirectoryURL_(objc.NSURL.fileURLWithPath_(o.directory));
  if (o.defaultName) p.setNameFieldStringValue_(o.defaultName);
  if (o.types?.length) {
    const types = o.types.map((t) =>
      objc.UTType.typeWithFilenameExtension_(t.replace(/^\./, "")),
    ).filter(Boolean);
    if (types.length) p.setAllowedContentTypes_(types);
  }
}

/** Open panel, as a sheet. Resolves to the chosen paths (empty if cancelled). */
export function openFile(options: FileDialogOptions = {}): Promise<string[]> {
  const p = objc.NSOpenPanel.openPanel();
  p.setAllowsMultipleSelection_(options.multiple ?? false);
  p.setCanChooseDirectories_(options.chooseDirectories ?? false);
  p.setCanChooseFiles_(options.chooseFiles ?? true);
  p.setCanCreateDirectories_(options.canCreateDirectories ?? false);
  configurePanel(p, options);

  const parent = nativeWindow(options.window);
  return new Promise<string[]>((resolve) => {
    const handler = createBlock("v@?q", (response: number) => {
      const out: string[] = [];
      if (Number(response) === ModalResponse.OK) {
        const urls = p.URLs();
        const n = Number(urls.count());
        for (let i = 0; i < n; i++) out.push(str(urls.objectAtIndex_(i).path()));
      }
      resolve(out);
      queueMicrotask(() => handler.dispose());
    });
    if (parent) p.beginSheetModalForWindow_completionHandler_(parent, handler);
    else p.beginWithCompletionHandler_(handler);
  });
}

/** Save panel, as a sheet. Resolves to the chosen path or null. */
export function saveFile(options: FileDialogOptions = {}): Promise<string | null> {
  const p = objc.NSSavePanel.savePanel();
  p.setCanCreateDirectories_(options.canCreateDirectories ?? true);
  configurePanel(p, options);

  const parent = nativeWindow(options.window);
  return new Promise<string | null>((resolve) => {
    const handler = createBlock("v@?q", (response: number) => {
      const url = Number(response) === ModalResponse.OK ? p.URL() : null;
      resolve(url ? str(url.path()) : null);
      queueMicrotask(() => handler.dispose());
    });
    if (parent) p.beginSheetModalForWindow_completionHandler_(parent, handler);
    else p.beginWithCompletionHandler_(handler);
  });
}

/** A text-entry prompt built from an alert plus an accessory field. */
export function prompt(
  title: string,
  options: { message?: string; value?: string; placeholder?: string; window?: Window } = {},
): Promise<string | null> {
  const a = objc.NSAlert.alloc().init();
  a.setMessageText_(title);
  if (options.message) a.setInformativeText_(options.message);
  a.addButtonWithTitle_("OK");
  a.addButtonWithTitle_("Cancel");

  const field = objc.NSTextField.alloc().initWithFrame_({ x: 0, y: 0, width: 260, height: 24 });
  if (options.value) field.setStringValue_(options.value);
  if (options.placeholder) field.setPlaceholderString_(options.placeholder);
  a.setAccessoryView_(field);

  const parent = nativeWindow(options.window);
  const host = parent ? undefined : hostWindow();
  return new Promise<string | null>((resolve) => {
    const handler = createBlock("v@?q", (response: number) => {
      if (host) closeHost(host);
      const ok = Number(response) === ModalResponse.AlertFirstButton;
      resolve(ok ? str(field.stringValue()) : null);
      queueMicrotask(() => handler.dispose());
    });
    // Hung from a transparent host when no window is on screen — never runModal (see alert).
    const sheetParent = parent ?? host;
    a.beginSheetModalForWindow_completionHandler_(sheetParent, handler);
    // Give the field focus once the sheet is up.
    queueMicrotask(() => sheetParent.makeFirstResponder_(field));
  });
}

/**
 * Post a user notification (banner).
 *
 * Returns false when the platform has no notification centre available to this
 * process — an unbundled binary has no bundle identifier, and NSUserNotification
 * is deprecated besides, so this is best-effort by nature.
 */
export function notify(title: string, body?: string): boolean {
  const cls = tryClass("NSUserNotificationCenter");
  const center = cls?.send("defaultUserNotificationCenter");
  if (!center) return false;
  const n = tryClass("NSUserNotification")?.alloc().init();
  if (!n) return false;
  n.setTitle_(title);
  if (body) n.setInformativeText_(body);
  center.deliverNotification_(n);
  return true;
}

// NSBeep is a plain C function, not a method on NSSound.
const nsBeep = cfunction("NSBeep", "v");

export function beep(): void {
  nsBeep?.();
}
