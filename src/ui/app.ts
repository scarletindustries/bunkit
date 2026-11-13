// Application — the shell that owns the pump loop and the menu bar.

import { objc } from "../objc.ts";
import {
  ActivationPolicy,
  counted,
  initApp,
  isRunning,
  MainLoop,
  onFrame,
  onQuit,
  pumpOnce,
  quit,
  run,
  type FrameInfo,
  type RunOptions,
  type Stall,
} from "../runtime.ts";
import { Menu, standardMenu, type StandardMenuOptions } from "./menu.ts";
import { Window, allWindows } from "./window.ts";

export interface ApplicationOptions extends RunOptions {
  name?: string;
  /** Pass `false` for no menu bar, or options for the standard one. */
  menu?: false | StandardMenuOptions | Menu;
  /** "regular" shows in the Dock; "accessory" is a menu-bar-only app. */
  policy?: "regular" | "accessory" | "prohibited";
  onReady?: (app: Application) => void | Promise<void>;
  onQuit?: () => void | Promise<void>;
  /**
   * End the process once the app has quit and every `onQuit` handler has run.
   * Default true — and it matters: a GUI app almost always has a setInterval or
   * two running, and an interval keeps Bun's event loop alive forever, so
   * without this the window disappears but the process never exits. Put
   * shutdown work in `onQuit`, not after `await app.run()`.
   */
  exitOnQuit?: boolean;
}

export class Application {
  readonly options: ApplicationOptions;
  menu: Menu | null = null;

  constructor(options: ApplicationOptions = {}) {
    this.options = options;
    const policy =
      options.policy === "accessory" ? ActivationPolicy.Accessory
      : options.policy === "prohibited" ? ActivationPolicy.Prohibited
      : ActivationPolicy.Regular;
    initApp(policy);

    if (options.menu instanceof Menu) {
      this.menu = options.menu;
      objc.NSApplication.sharedApplication().setMainMenu_(options.menu.native);
    } else if (options.menu !== false) {
      this.menu = standardMenu({
        appName: options.name,
        onQuit: () => void options.onQuit?.(),
        ...(typeof options.menu === "object" ? options.menu : {}),
      });
    }

    if (options.onQuit) onQuit(options.onQuit);
  }

  get native(): any {
    return objc.NSApplication.sharedApplication();
  }

  get windows(): Window[] {
    return allWindows();
  }

  /**
   * Own the main thread until quit() is called.
   *
   * By default the process ends when this returns, so statements after
   * `await app.run()` do not run — use `onQuit` for shutdown work, or pass
   * `exitOnQuit: false` if you really want to keep going.
   */
  async run(): Promise<void> {
    if (this.options.onReady) await this.options.onReady(this);
    await run(this.options);
    if (this.options.exitOnQuit !== false) process.exit(0);
  }

  quit(): void {
    quit();
  }

  get running(): boolean {
    return isRunning();
  }

  /** Process pending AppKit events without entering the loop. */
  pump(seconds = 0): number {
    return pumpOnce(seconds);
  }

  /** Bring the app to the front. */
  activate(): void {
    this.native.activateIgnoringOtherApps_(true);
  }

  /** Set the Dock badge text (empty string clears it). */
  set badge(v: string) {
    this.native.dockTile().setBadgeLabel_(v || null);
    this.native.dockTile().display();
  }

  /** Replace the Dock icon with an image. */
  setIcon(image: any): void {
    this.native.setApplicationIconImage_(image);
  }

  /** True when the system is in dark mode. */
  get isDark(): boolean {
    const name = this.native.effectiveAppearance()?.name?.();
    return String(name ?? "").includes("Dark");
  }
}

export { quit, run, initApp, pumpOnce, onQuit, MainLoop, onFrame, counted };
export type { FrameInfo, Stall };
