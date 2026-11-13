// Application lifecycle and the cooperative run loop.
//
// AppKit's run loop and Bun's event loop both want to own the main thread. We
// give the thread to AppKit in short slices and hand it back to Bun in between.

import { lib } from "./bridge.ts";
import { objc, withPool, type ObjCObject } from "./objc.ts";
import {
  ensureMainLoop, framesSoFar, idleWait, isAnimating, runShutdown, setTurnBudget, tickFrames,
} from "./mainloop.ts";

export const ActivationPolicy = {
  Regular: 0,
  Accessory: 1,
  Prohibited: 2,
} as const;

export interface RunOptions {
  /**
   * How long a single pump blocks in the kernel while the app is being used.
   * This bounds input latency. Lower = snappier, more wakeups.
   */
  pumpSeconds?: number;
  /**
   * Pump budget once the app has gone quiet. The rest of each idle iteration is
   * spent asleep in *Bun* instead, which is what keeps JS timers accurate: time
   * blocked inside AppKit is time Bun's event loop cannot run.
   */
  idlePumpSeconds?: number;
  /** How long to sleep in Bun per idle iteration, in milliseconds. */
  idleSleepMs?: number;
  /**
   * Sleep once the app has been quiet for a very long time. Off by default:
   * measured on an M-series Mac it saves ~0.3 points of idle CPU but costs a
   * 16ms animation timer about 9 points of accuracy, which is the wrong trade
   * unless you know the app never animates while idle. Enable by also setting
   * `deepIdleAfter`.
   */
  deepIdleSleepMs?: number;
  /** Consecutive event-free pumps before switching to the idle cadence. */
  idleAfter?: number;
  /** Consecutive event-free pumps before backing off further. Default: never. */
  deepIdleAfter?: number;
  /** Dock/menu-bar behaviour. */
  activationPolicy?: number;
  /** Quit once the last window closes. Default true. */
  quitAfterLastWindow?: boolean;
  /**
   * How long one main-loop turn may run before the rest of its work waits for the next, in
   * milliseconds. Default 8: a flood of work must not starve AppKit's own event handling inside
   * a menu.
   */
  turnBudgetMs?: number;
}

let initialised = false;
let running = false;
let stopRequested = false;
let stopResolve: (() => void) | null = null;
const quitHandlers: Array<() => void | Promise<void>> = [];

/** Initialise NSApplication. Safe to call more than once. */
export function initApp(policy: number = ActivationPolicy.Regular): void {
  if (initialised) return;
  initialised = true;
  lib.br_app_init(policy);
  // A pool for everything that happens before the first pump.
  lib.br_autorelease_pool_push();
  ensureMainLoop();
}

/*
 * Frames, timers and tasks live on the main loop (src/mainloop.ts): they run on AppKit's run
 * loop in its common modes, so they keep running inside menus, live resize and control tracking,
 * and only at safe points, so a turn never starts while any of your JavaScript is on the stack.
 *
 * Frame callbacks run on the display's clock, each paced by the screen it is on — not once per
 * pump iteration as in v1. `frameTick` still counts frames, so an input edge recorded between two
 * frames reads as having happened in the next one.
 */
export {
  MainLoop,
  counted,
  onFrame,
  frameTick,
  tickFrames,
  setAnimating,
  isAnimating,
  type FrameInfo,
  type Disposable,
  type MainLoopStats,
  type Stall,
} from "./mainloop.ts";

export function onQuit(fn: () => void | Promise<void>): void {
  quitHandlers.push(fn);
}

export function quit(): void {
  stopRequested = true;
  lib.br_stop();
  lib.br_post_empty_event(); // wake a pump that is blocked in mach_msg
  if (stopResolve) {
    const r = stopResolve;
    stopResolve = null;
    r();
  }
}

export function isRunning(): boolean {
  return running;
}

/**
 * Process pending AppKit events once, without entering the loop.
 *
 * Also recycles the base autorelease pool, so a script that drives the app by
 * calling pumpOnce in a loop of its own does not accumulate every temporary
 * AppKit handed back since startup.
 */
export function pumpOnce(seconds = 0): number {
  lib.br_autorelease_pool_recycle();
  const frames = framesSoFar();
  // A safe point: main-loop turns run in here, frames among them. Calling the pump is choosing
  // a point to run the loop at, as v1's frames and AppKit's callbacks already ran in it.
  const handled = lib.br_pump(seconds);
  // A frame a call, as in v1: when the display's clock brought none during this pump, run one
  // now, so a script that drives the app by hand still gets one.
  if (framesSoFar() === frames) tickFrames();
  return handled;
}

/**
 * Own the main thread until quit() is called.
 *
 * Each iteration: block in AppKit for up to `pumpSeconds`, drain the rest of the
 * queue, then yield a turn to Bun so timers, promises and I/O make progress.
 */
export async function run(options: RunOptions = {}): Promise<void> {
  const activePump = options.pumpSeconds ?? 0.004;
  const idlePump = options.idlePumpSeconds ?? 0.002;
  const idleSleep = options.idleSleepMs ?? 8;
  const deepIdleSleep = options.deepIdleSleepMs ?? 16;
  const idleAfter = options.idleAfter ?? 20;
  const deepIdleAfter = options.deepIdleAfter ?? Number.POSITIVE_INFINITY;

  initApp(options.activationPolicy ?? ActivationPolicy.Regular);
  lib.br_set_terminate_after_last_window(options.quitAfterLastWindow === false ? 0 : 1);
  if (options.turnBudgetMs !== undefined) setTurnBudget(options.turnBudgetMs);

  running = true;
  stopRequested = false;
  let quiet = 0;

  try {
    while (!stopRequested && !lib.br_should_stop()) {
      // An animating view needs the fast cadence even with no input events: its frames come
      // from a display link, which fires only while the pump is in AppKit.
      const animating = isAnimating();
      const idle = quiet >= idleAfter && !animating;
      const deep = quiet >= deepIdleAfter && !animating;
      // Recycle the base pool (pushed by initApp) before nesting this
      // iteration's pool inside it, so work done outside run() drains too.
      lib.br_autorelease_pool_recycle();
      lib.br_autorelease_pool_push();
      try {
        const handled = lib.br_pump(idle ? idlePump : activePump);
        quiet = handled > 0 ? 0 : quiet + 1;
      } finally {
        // Yield to Bun. Anything Bun runs here is still inside the pool, so
        // JS-created temporaries drain on the same tick. While idle we do the
        // waiting *here* rather than inside AppKit, which roughly halves idle
        // CPU and keeps setTimeout/setInterval close to their nominal period —
        // but never past the main loop's next timer, and not at all once
        // anything signals it (a thread, net, a posted task).
        await idleWait(deep ? deepIdleSleep : idle ? idleSleep : 0);
        lib.br_autorelease_pool_pop();
      }
    }
  } finally {
    running = false;
  }

  for (const h of quitHandlers) {
    try {
      await h();
    } catch (e) {
      console.error("[runtime] quit handler failed:", e);
    }
  }
  // Then threads, against one deadline (bunkit/thread).
  await runShutdown();
  lib.br_autorelease_pool_pop(); // the pool pushed by initApp
}

/** Run `fn` on the next pump iteration (useful from inside a delegate). */
export function nextTick(fn: () => void): void {
  queueMicrotask(() => {
    try {
      fn();
    } catch (e) {
      console.error("[runtime]", e);
    }
  });
}

export { withPool };

// --- shared NSApplication access -------------------------------------------

let sharedApp: ObjCObject | null = null;
export function NSApp(): ObjCObject {
  if (!sharedApp) {
    initApp();
    sharedApp = objc.NSApplication.sharedApplication();
  }
  return sharedApp!;
}
