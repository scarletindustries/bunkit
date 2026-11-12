// The main loop: BunKit's own timers, tasks, frames and deliveries.
//
// They are scheduled on AppKit's run loop in its common modes (native/src/mainloop.m), so they
// keep running inside every nested loop AppKit enters from event dispatch — an open menu, a live
// resize, a slider being dragged, a modal session — where nothing of Bun's runs at all. And they
// run **only at safe points**: when the only JavaScript on the stack is BunKit's own pump. Each
// run is a whole turn, ending with a microtask checkpoint after every callback, so JavaScript's
// run-to-completion guarantee holds. docs/main-loop/spec.md is the design; this file is §4 (the
// turn and the API), §5 (frames) and §8 (statistics).
//
// Nothing here patches setTimeout or any other global: these are not Bun's timers and do not
// pretend to be (§10).

import { drainMicrotasks } from "bun:jsc";
import { lib, asPointer, toArrayBuffer, JSCallback, FFIType, LIB_PATH } from "./bridge.ts";

// ---------------------------------------------------------------------------
// State shared with mainloop.m: a static both sides read, so keeping it costs no FFI call.
// The indices mirror br_main_state in native/src/bridge.h.
// ---------------------------------------------------------------------------

const U_CALLBACK_DEPTH = 0;
const U_IN_PUMP = 1;
const U_IN_TURN = 2;
const U_PENDING_TURN = 3;
const U_PENDING = 4;
const U_BUN_IDLE = 5;
const U_BUN_WAKE = 6;
const U_SCREENS = 7;
const U_CLOCKS_RUNNING = 9;
const U_SIGNALLED = 10;
const F_NEXT_DELAY = 0;
const F_STALL_MS = 1;
const F_NEXT_DUE = 2;

const PENDING_FRAMES = 1;
const PENDING_COMPLETIONS = 2;
const PENDING_NET = 4;
const PENDING_NESTED = 8;
const PENDING_STALLS = 16;

const stateBytes = toArrayBuffer(asPointer(Number(lib.br_main_state_ptr())), 0, 128);
const U = new Uint32Array(stateBytes, 0, 16);
const F = new Float64Array(stateBytes, 64, 8);

const MAX_CLOCKS = 16;
const CLOCK_BYTES = 64;
const clockBytes = toArrayBuffer(asPointer(Number(lib.br_main_clocks_ptr())), 0, MAX_CLOCKS * CLOCK_BYTES);
const CU = new Uint32Array(clockBytes);
const CF = new Float64Array(clockBytes);
// Per slot: u32 [due, displayID, running, fallback], f64 [timestamp, targetTimestamp, duration,
// fired, missed] from word 2 of the slot's eight.
const cu = (slot: number, field: number) => slot * 16 + field;
const cf = (slot: number, field: number) => slot * 8 + 2 + field;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A disposable handle: `using t = MainLoop.every(…)` stops it at the end of the scope. */
export interface Disposable {
  dispose(): void;
  [Symbol.dispose](): void;
}

/** One frame of a display, from its display link: seconds, on the clock of `br_now()`. */
export interface FrameInfo {
  /** When the frame being shown now was displayed. */
  timestamp: number;
  /** When the frame you draw now will be displayed. */
  targetTimestamp: number;
  /** The display's refresh interval: `targetTimestamp - timestamp`. */
  duration: number;
}

/** Something that has a native view: a BunKit {@link View}, or anything shaped like one. */
export interface HasNativeView {
  native: { ptr: bigint };
}

/** The main thread was held: reported when the hold ends. */
export interface Stall {
  durationMs: number;
  /** The run-loop mode AppKit held it in, or `""` for none (a slow event, a long turn). */
  mode: string;
  /**
   * `"event"`: AppKit, from event dispatch (a menu, a resize, a drag, a slow handler).
   * `"javascript"`: a nested loop entered with JavaScript on the stack (§6.2).
   * `"turn"`: a main-loop turn that ran long.
   */
  origin: "event" | "javascript" | "turn";
}

export interface ModeStats {
  count: number;
  totalMs: number;
  longestMs: number;
}

export interface MainLoopStats {
  /** Nested run loops: AppKit holding the main thread in a loop of its own. */
  nested: ModeStats & {
    /** How many were entered with JavaScript on the stack (§6.2). */
    fromJavaScript: number;
    byMode: Record<string, ModeStats>;
  };
  /** Bun's own loop: the longest it waited for the main thread, in one pump. */
  bun: { longestWaitMs: number };
  /** How late main-loop timers ran, over the last 1024. */
  timers: { run: number; p50LatenessMs: number; p99LatenessMs: number; maxLatenessMs: number };
  /** Main-loop turns: how many, how many came due off a safe point, and how long they took. */
  turns: { count: number; deferred: number; p50Ms: number; p99Ms: number; maxMs: number };
  /** Frames: per clock (one per screen) and per subscriber. */
  frames: {
    delivered: number;
    missed: number;
    clocks: Array<{ display: number; fired: number; missed: number; running: boolean }>;
    views: Array<{ name: string; delivered: number; missed: number }>;
  };
}

// ---------------------------------------------------------------------------
// The checkpoint (§4.2, open question 2)
// ---------------------------------------------------------------------------
//
// Measured (docs/main-loop/experiments/checkpoint.ts): queued with process.nextTick and followed
// by drainMicrotasks(), a callback is run by Bun's own tick runner, which then runs its nextTicks,
// then the microtasks, and round again until both are empty — the order Bun keeps after one of its
// own tasks. A plain call followed by drainMicrotasks() runs promise reactions first.

function invoke(fn: (arg?: any) => void, arg: unknown): void {
  try {
    fn(arg);
  } catch (e) {
    console.error("[bunkit] a main-loop callback threw:", e);
  }
}

/** Run `fn(arg)` as one task: the callback, then a checkpoint. */
function runCallback(fn: (arg?: any) => void, arg?: unknown): void {
  process.nextTick(invoke, fn, arg);
  try {
    drainMicrotasks();
  } catch (e) {
    console.error("[bunkit] a microtask queued in a main-loop turn threw:", e);
  }
}

// ---------------------------------------------------------------------------
// Statistics kept here (§8)
// ---------------------------------------------------------------------------

class Samples {
  readonly #values = new Float64Array(1024);
  #count = 0;
  #max = 0;
  add(v: number): void {
    this.#values[this.#count++ % this.#values.length] = v;
    if (v > this.#max) this.#max = v;
  }
  get count(): number {
    return this.#count;
  }
  get max(): number {
    return this.#max;
  }
  quantile(q: number): number {
    const n = Math.min(this.#count, this.#values.length);
    if (n === 0) return 0;
    const sorted = this.#values.slice(0, n).sort();
    return sorted[Math.min(n - 1, Math.floor(q * n))]!;
  }
  reset(): void {
    this.#count = 0;
    this.#max = 0;
  }
}

const lateness = new Samples();
const turnTimes = new Samples();

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** A development build: running from source, where §6.2 captures the JavaScript stack. */
const DEV = !import.meta.url.includes("$bunfs") || process.env.BUNKIT_DEV === "1";

let initialised = false;
const stacks = new Map<number, string>();

const turnCallback = new JSCallback(turn, { args: [], returns: FFIType.void });
const stackCallback = new JSCallback(
  (seq: number) => {
    // Side-effect free, and the one JavaScript run off a safe point (§6.2).
    if (stacks.size < 256) stacks.set(seq, new Error().stack ?? "");
  },
  { args: [FFIType.u32], returns: FFIType.void },
);
let wakeBun: (() => void) | undefined;
const wakeCallback = new JSCallback(
  () => {
    Atomics.store(U, U_BUN_WAKE, 0);
    const wake = wakeBun;
    wakeBun = undefined;
    wake?.();
  },
  { args: [], returns: FFIType.void, threadsafe: true },
);

/** Install the main loop on the main run loop. Safe to call more than once. */
export function ensureMainLoop(): void {
  if (initialised) return;
  initialised = true;
  lib.br_main_init(turnCallback.ptr, DEV ? stackCallback.ptr : null, wakeCallback.ptr);
  // After this no native thread calls into a VM that is going away.
  process.on("exit", () => lib.br_main_shutdown());
}

// ---------------------------------------------------------------------------
// Timers and tasks
// ---------------------------------------------------------------------------

interface Timer {
  due: number; // performance.now(), ms
  seq: number;
  fn: () => void;
  period: number; // 0 for once
  tolerance: number;
  live: boolean;
}

/** A binary heap of timers by due time, then by creation. */
const heap: Timer[] = [];
let timerSeq = 0;

function before(a: Timer, b: Timer): boolean {
  return a.due < b.due || (a.due === b.due && a.seq < b.seq);
}

function heapPush(t: Timer): void {
  heap.push(t);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!before(heap[i]!, heap[p]!)) break;
    [heap[i], heap[p]] = [heap[p]!, heap[i]!];
    i = p;
  }
}

function heapPop(): Timer | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && before(heap[l]!, heap[m]!)) m = l;
      if (r < heap.length && before(heap[r]!, heap[m]!)) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  }
  return top;
}

/** Drop cancelled timers off the top, so heap[0] is the next live one. */
function heapTop(): Timer | undefined {
  while (heap.length > 0 && !heap[0]!.live) heapPop();
  return heap[0];
}

let tasks: Array<() => void> = [];
let taskHead = 0;

/** Whether a signal is already on its way: one per batch of work posted outside a turn. */
let signalled = false;
let turning = false;

function signal(): void {
  if (signalled) return;
  signalled = true;
  ensureMainLoop();
  lib.br_main_signal();
}

/** The due time the deadline timer is armed for, or Infinity. */
let armedFor = Infinity;

/** When the deadline timer must fire next: the earliest due time, stretched by tolerance. */
function nextWake(): number {
  let wake = Infinity;
  for (const t of heap) {
    if (t.live && t.due + t.tolerance < wake) wake = t.due + t.tolerance;
  }
  return wake;
}

/** Arm the deadline timer for `wake`. In a turn mainloop.m does it when the turn returns. */
function arm(wake: number): void {
  if (wake === Infinity) {
    F[F_NEXT_DELAY] = -1;
    F[F_NEXT_DUE] = -1;
  } else {
    F[F_NEXT_DELAY] = Math.max(0, wake - performance.now()) / 1000;
    F[F_NEXT_DUE] = wake;
  }
  armedFor = wake;
  if (!turning) {
    ensureMainLoop();
    lib.br_main_arm(F[F_NEXT_DELAY]!);
  }
}

function addTimer(ms: number, fn: () => void, period: number, tolerance: number): Disposable {
  if (typeof fn !== "function") throw new TypeError("MainLoop: a callback is required");
  const t: Timer = {
    due: performance.now() + Math.max(0, ms),
    seq: timerSeq++,
    fn,
    period,
    tolerance: Math.max(0, tolerance),
    live: true,
  };
  heapPush(t);
  if (t.due + t.tolerance < armedFor) arm(t.due + t.tolerance);
  const stop = () => {
    t.live = false;
  };
  return { dispose: stop, [Symbol.dispose]: stop };
}

// ---------------------------------------------------------------------------
// Sources: channels from threads (§7.2), net (§7.5), and anything else a turn drains
// ---------------------------------------------------------------------------

/** Something a turn drains. `run` returns whether it did anything. */
export interface TurnSource {
  run(deadline: number): boolean;
}

const sources = new Set<TurnSource>();

/** Drain `source` in every turn until the returned function is called. */
export function addTurnSource(source: TurnSource): () => void {
  ensureMainLoop();
  sources.add(source);
  return () => sources.delete(source);
}

let pendingBits = 0;

/** Take a BR_PENDING_* bit a turn found set: true once per time native code set it. */
export function takePending(bit: number): boolean {
  pendingBits |= Atomics.exchange(U, U_PENDING, 0);
  if ((pendingBits & bit) === 0) return false;
  pendingBits &= ~bit;
  return true;
}

export const Pending = { NET: PENDING_NET } as const;

/** Run `fn(arg)` as a task of the current turn: the callback, then a checkpoint. */
export function runInTurn<A>(fn: (arg: A) => void, arg: A): void {
  runCallback(fn as (arg?: unknown) => void, arg);
}

/** Is a turn running now? */
export function inTurn(): boolean {
  return turning;
}

/** Ask for a turn soon: a source with more to deliver than its budget allowed. */
export function requestTurn(): void {
  signalled = false;
  signal();
}

/** The path of BunKit's native library, for a thread to open the same one. */
export function libraryPath(): string {
  return LIB_PATH;
}

const shutdownHooks: Array<() => void | Promise<void>> = [];

/** Run `fn` when run() ends, after the quit handlers: how threads are ended on quit. */
export function onShutdown(fn: () => void | Promise<void>): void {
  shutdownHooks.push(fn);
}

/** @internal Called by run() once the quit handlers have run. */
export async function runShutdown(): Promise<void> {
  for (const h of shutdownHooks.splice(0)) {
    try {
      await h();
    } catch (e) {
      console.error("[runtime] shutdown failed:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Trampolined calls (§6.1): completions come back in a turn
// ---------------------------------------------------------------------------

const COMPLETION_BYTES = 48;
const completionBytes = new Uint8Array(COMPLETION_BYTES * 64);
const completionView = new DataView(completionBytes.buffer);
const waiting = new Map<number, { resolve(v: any): void; reject(e: Error): void; decode(view: DataView, offset: number): any; what: string }>();

/**
 * Wait for the trampolined call `token` (from `br_main_post_send`): resolves in the turn after it
 * returns, with the return value `decode` reads from its 32 bytes.
 */
export function awaitCompletion<T>(
  token: number,
  what: string,
  decode: (view: DataView, offset: number) => T,
): Promise<T> {
  ensureMainLoop();
  return new Promise<T>((resolve, reject) => waiting.set(token, { resolve, reject, decode, what }));
}

function takeCompletions(): void {
  for (;;) {
    const n = lib.br_main_take_completions(completionBytes, 64) as number;
    for (let i = 0; i < n; i++) {
      const o = i * COMPLETION_BYTES;
      const token = completionView.getUint32(o, true);
      const rc = completionView.getInt32(o + 4, true);
      const w = waiting.get(token);
      if (!w) continue;
      waiting.delete(token);
      runCallback(() => {
        if (rc !== 0) w.reject(new Error(`${w.what} failed (error ${rc})`));
        else w.resolve(w.decode(completionView, o + 16));
      });
    }
    if (n < 64) break;
  }
}

// ---------------------------------------------------------------------------
// Nested loops entered with JavaScript on the stack (§6.2) and stalls (§8)
// ---------------------------------------------------------------------------

const recordBytes = new Uint8Array(24 * 64);
const recordView = new DataView(recordBytes.buffer);
const reportedSites = new Set<string>();

function modeName(index: number): string {
  if (index < 0) return "";
  return String(lib.br_main_mode_name(index) ?? "");
}

/** The first frame of a stack that is not BunKit's own bridge: the call that nested. */
export function callSite(stack: string): string {
  const lines = stack.split("\n").slice(1).map((l) => l.trim());
  // BunKit's own frames, and the FFI call itself ("at br_msgsend (unknown)").
  const own = /[\\/]src[\\/](objc|bridge|mainloop)\.ts|\(unknown\)|bun:ffi|\[native code\]/;
  for (const line of lines) {
    if (!line.startsWith("at ")) continue;
    if (own.test(line)) continue;
    return line.slice(3);
  }
  return lines[0]?.replace(/^at /, "") ?? "an unknown call site";
}

/** For tests: every report §6.2 has made. */
export const nestingReports: Array<{ mode: string; durationMs: number; site: string; message: string }> = [];

function takeNested(): void {
  for (;;) {
    const n = lib.br_main_take_nested(recordBytes, 64) as number;
    for (let i = 0; i < n; i++) {
      const o = i * 24;
      const seq = recordView.getUint32(o, true);
      const mode = modeName(recordView.getInt32(o + 4, true));
      const ms = recordView.getFloat64(o + 8, true);
      const stack = stacks.get(seq);
      stacks.delete(seq);
      const site = stack !== undefined
        ? callSite(stack)
        : "an unknown call site (the stack is captured in development builds)";
      const message =
        `[bunkit] AppKit ran a nested run loop (${mode || "an unknown mode"}) for ${ms.toFixed(0)} ms ` +
        `while JavaScript was on the stack, from ${site}. The main loop waited. ` +
        `Use the asynchronous API instead.`;
      nestingReports.push({ mode, durationMs: ms, site, message });
      if (nestingReports.length > 256) nestingReports.shift();
      if (reportedSites.has(site)) continue;
      reportedSites.add(site);
      console.warn(message);
    }
    if (n < 64) break;
  }
}

interface StallListener {
  fn: (stall: Stall) => void;
  thresholdMs: number;
}
const stallListeners = new Set<StallListener>();
const ORIGINS = ["event", "javascript", "turn"] as const;

function updateStallThreshold(): void {
  let min = 0;
  for (const l of stallListeners) if (min === 0 || l.thresholdMs < min) min = l.thresholdMs;
  F[F_STALL_MS] = min;
}

function deliverStall(stall: Stall): void {
  for (const l of [...stallListeners]) {
    if (stall.durationMs >= l.thresholdMs) runCallback(l.fn, stall);
  }
}

function takeStalls(): void {
  for (;;) {
    const n = lib.br_main_take_stalls(recordBytes, 64) as number;
    for (let i = 0; i < n; i++) {
      const o = i * 24;
      deliverStall({
        durationMs: recordView.getFloat64(o, true),
        mode: modeName(recordView.getInt32(o + 8, true)),
        origin: ORIGINS[recordView.getInt32(o + 12, true)] ?? "event",
      });
    }
    if (n < 64) break;
  }
}

/** A turn that ran past the stall threshold, reported in the next. */
let longTurn: Stall | undefined;

// ---------------------------------------------------------------------------
// Frames (§5)
// ---------------------------------------------------------------------------
//
// One clock per screen (a display link, in mainloop.m), so all of a screen's frame callbacks run
// in one turn. A subscriber is on the clock of the screen its view is on — the main screen for
// `onFrame` — and moves when its window moves or the screens change. A clock runs only while
// something is subscribed to it, so an idle app has no frame wakeups.

interface Subscriber {
  fn: (frame: FrameInfo) => void;
  /** The display this subscriber is on now. */
  resolve: () => number;
  name: string;
  clock: Clock | undefined;
  once: boolean;
  delivered: number;
  missedAt: number;
}

interface Clock {
  slot: number;
  display: number;
  subscribers: Set<Subscriber>;
}

const clocks = new Map<number, Clock>();
const subscribers = new Set<Subscriber>();
let screensSeen = 0;
let framesDelivered = 0;
let tick = 0;
let animators = 0;

function clockFor(display: number): Clock | undefined {
  let clock = clocks.get(display);
  if (clock && CU[cu(clock.slot, 1)] !== display) {
    // Closed natively: its screen went away.
    clocks.delete(display);
    clock = undefined;
  }
  if (clock) return clock;
  ensureMainLoop();
  const slot = lib.br_main_clock_open(display) as number;
  if (slot < 0) return undefined;
  clock = { slot, display, subscribers: new Set() };
  clocks.set(display, clock);
  return clock;
}

function attach(s: Subscriber): void {
  const display = s.resolve() || (lib.br_main_main_display() as number);
  if (s.clock && s.clock.display === display && CU[cu(s.clock.slot, 1)] === display) return;
  detach(s);
  const clock = clockFor(display);
  if (!clock) return;
  s.clock = clock;
  s.missedAt = CF[cf(clock.slot, 4)]!;
  clock.subscribers.add(s);
  if (clock.subscribers.size === 1) lib.br_main_clock_run(clock.slot, 1);
}

function detach(s: Subscriber): void {
  const clock = s.clock;
  if (!clock) return;
  s.clock = undefined;
  clock.subscribers.delete(s);
  if (clock.subscribers.size === 0 && CU[cu(clock.slot, 1)] === clock.display) {
    lib.br_main_clock_run(clock.slot, 0);
  }
}

function subscribe(
  fn: (frame: FrameInfo) => void,
  resolve: () => number,
  name: string,
  once = false,
): () => void {
  const s: Subscriber = { fn, resolve, name, clock: undefined, once, delivered: 0, missedAt: 0 };
  subscribers.add(s);
  attach(s);
  return () => {
    if (!subscribers.delete(s)) return;
    detach(s);
  };
}

const mainDisplay = () => lib.br_main_main_display() as number;

/** Run `fn` on every frame of the main screen. Returns a function that stops it. */
export function onFrame(fn: (frame: FrameInfo) => void): () => void {
  return subscribe(fn, mainDisplay, "onFrame");
}

/** Run `fn` on every frame of the screen `view` is on. Returns a function that stops it. */
export function onViewFrame(view: HasNativeView, fn: (frame: FrameInfo) => void, name = "view"): () => void {
  return subscribe(fn, () => lib.br_main_display_of(view.native.ptr) as number, name);
}

/** Re-attach every subscriber when screens changed or a window moved to another one. */
function checkScreens(): void {
  const seen = U[U_SCREENS]!;
  if (seen === screensSeen) return;
  screensSeen = seen;
  for (const s of subscribers) attach(s);
}

function deliverFrames(): void {
  checkScreens();
  let any = false;
  for (const clock of [...clocks.values()]) {
    const slot = clock.slot;
    if (Atomics.load(CU, cu(slot, 0)) === 0) continue;
    Atomics.store(CU, cu(slot, 0), 0);
    const frame: FrameInfo = {
      timestamp: CF[cf(slot, 0)]!,
      targetTimestamp: CF[cf(slot, 1)]!,
      duration: CF[cf(slot, 2)]!,
    };
    any = true;
    for (const s of [...clock.subscribers]) {
      s.delivered++;
      if (s.once) {
        subscribers.delete(s);
        detach(s);
      }
      runCallback(s.fn, frame);
    }
  }
  if (any) endFrame();
}

/**
 * The frame is over. Advanced *after* the callbacks, not before: anything an event recorded
 * since the last frame — a key going down, a mouse delta — is stamped with the tick the callbacks
 * are still running under, and reads as having happened this frame.
 */
function endFrame(): void {
  framesDelivered++;
  tick++;
}

/** Frames delivered from the display clocks so far. */
export function framesSoFar(): number {
  return framesDelivered;
}

/**
 * Frames so far: anything that has to tell "this frame" from an earlier one — an input edge, a
 * per-frame delta — compares against this rather than keeping its own flag.
 */
export function frameTick(): number {
  return tick;
}

/**
 * Run every frame subscriber once, now, outside the display's clock: what `pumpOnce` does when no
 * frame came during its pump, so a script that drives the app by hand still gets one a call.
 */
export function tickFrames(): void {
  const now = lib.br_now() as number;
  const frame: FrameInfo = { timestamp: now, targetTimestamp: now + 1 / 60, duration: 1 / 60 };
  for (const s of [...subscribers]) {
    if (!s.clock) attach(s);
    s.delivered++;
    if (s.once) {
      subscribers.delete(s);
      detach(s);
    }
    try {
      s.fn(frame);
    } catch (e) {
      console.error("[runtime] frame callback failed:", e);
    }
  }
  tick++;
}

/** Keep the loop at its active cadence while something animates. Refcounted. */
export function setAnimating(on: boolean): void {
  animators = Math.max(0, animators + (on ? 1 : -1));
}

/** Is anything animating: a `setAnimating` refcount, or a frame clock with subscribers? */
export function isAnimating(): boolean {
  return animators > 0 || U[U_CLOCKS_RUNNING]! > 0;
}

// ---------------------------------------------------------------------------
// The turn (§4.2)
// ---------------------------------------------------------------------------

let budgetMs = 8;

/** The turn's budget, ms: work past it waits for the next turn, so AppKit gets the thread back. */
export function setTurnBudget(ms: number): void {
  budgetMs = Math.max(0.5, ms);
}

function workRemains(now: number): boolean {
  if (taskHead < tasks.length) return true;
  const top = heapTop();
  return top !== undefined && top.due <= now;
}

function runTimers(deadline: number): boolean {
  let ran = false;
  for (;;) {
    const top = heapTop();
    const now = performance.now();
    if (!top || top.due > now) break;
    heapPop();
    lateness.add(now - top.due);
    if (top.period > 0) {
      // Never early, and missed runs coalesce into this one: the next is the first period
      // boundary after now, keeping the timer's phase.
      const k = Math.max(1, Math.ceil((now - top.due) / top.period));
      top.due += k * top.period;
      if (top.due <= now) top.due += top.period;
      heapPush(top);
    } else {
      top.live = false;
    }
    runCallback(top.fn);
    ran = true;
    if (performance.now() >= deadline) break;
  }
  return ran;
}

function runTasks(deadline: number): boolean {
  const end = tasks.length;
  if (taskHead >= end) return false;
  while (taskHead < end) {
    const fn = tasks[taskHead]!;
    tasks[taskHead++] = undefined as unknown as () => void;
    runCallback(fn);
    if (performance.now() >= deadline) break;
  }
  if (taskHead >= tasks.length) {
    tasks = [];
    taskHead = 0;
  } else if (taskHead > 1024 && taskHead * 2 > tasks.length) {
    tasks = tasks.slice(taskHead);
    taskHead = 0;
  }
  return true;
}

function turn(): void {
  const started = performance.now();
  const deadline = started + budgetMs;
  turning = true;
  signalled = false;
  try {
    pendingBits |= Atomics.exchange(U, U_PENDING, 0);
    if (pendingBits & PENDING_COMPLETIONS) {
      pendingBits &= ~PENDING_COMPLETIONS;
      takeCompletions();
    }
    if (pendingBits & PENDING_NESTED) {
      pendingBits &= ~PENDING_NESTED;
      takeNested();
    }
    if (pendingBits & PENDING_STALLS) {
      pendingBits &= ~PENDING_STALLS;
      takeStalls();
    }
    if (longTurn) {
      const stall = longTurn;
      longTurn = undefined;
      deliverStall(stall);
    }
    for (;;) {
      let ran = runTimers(deadline);
      if (performance.now() < deadline) ran = runTasks(deadline) || ran;
      for (const source of [...sources]) {
        if (performance.now() >= deadline) break;
        ran = source.run(deadline) || ran;
      }
      pendingBits |= Atomics.exchange(U, U_PENDING, 0);
      if (pendingBits & PENDING_FRAMES) {
        pendingBits &= ~PENDING_FRAMES;
        deliverFrames();
      } else if (U[U_SCREENS] !== screensSeen) {
        checkScreens();
      }
      if (!ran || performance.now() >= deadline) break;
    }
  } finally {
    const now = performance.now();
    arm(nextWake());
    turning = false;
    // Work left over past the budget: yield to AppKit, and come straight back.
    if (workRemains(now)) signal();
    const ms = now - started;
    turnTimes.add(ms);
    const threshold = F[F_STALL_MS]!;
    if (threshold > 0 && ms >= threshold) longTurn = { durationMs: ms, mode: "", origin: "turn" };
  }
}

// ---------------------------------------------------------------------------
// run()'s idle wait: in Bun, but ended early when the main loop has work
// ---------------------------------------------------------------------------

/**
 * Wait in Bun's loop for up to `ms`, as run() does while the app is idle, but no later than the
 * main loop's next deadline, and wake the moment anything signals the main loop — from this
 * thread, a worker or native code. Returns at once if something already has.
 */
export async function idleWait(ms: number): Promise<void> {
  if (ms <= 0) {
    await Bun.sleep(0);
    return;
  }
  const until = armedFor === Infinity ? ms : Math.min(ms, armedFor - performance.now());
  if (until <= 0.25) {
    await Bun.sleep(0);
    return;
  }
  Atomics.store(U, U_BUN_IDLE, 1);
  // A signal raised before the store above found bunIdle clear and woke no one: look for it.
  if (Atomics.load(U, U_SIGNALLED) !== 0 || Atomics.load(U, U_PENDING_TURN) !== 0) {
    Atomics.store(U, U_BUN_IDLE, 0);
    await Bun.sleep(0);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve) => {
    wakeBun = resolve;
    timer = setTimeout(resolve, until);
  });
  clearTimeout(timer);
  wakeBun = undefined;
  Atomics.store(U, U_BUN_IDLE, 0);
}

// ---------------------------------------------------------------------------
// The API (§4.3)
// ---------------------------------------------------------------------------

const nativeStats = new Float64Array(8 + 3 * 16);

function modeStats(o: number): ModeStats {
  return { count: nativeStats[o]!, totalMs: nativeStats[o + 1]!, longestMs: nativeStats[o + 2]! };
}

export const MainLoop = {
  /** Run `fn` once, at least `ms` later. */
  after(ms: number, fn: () => void): Disposable {
    return addTimer(ms, fn, 0, 0);
  },

  /** Run `fn` every `ms`, never early, coalescing missed runs into one. */
  every(ms: number, fn: () => void, options: { tolerance?: number } = {}): Disposable {
    if (!(ms > 0)) throw new RangeError("MainLoop.every: the period must be above 0 ms");
    return addTimer(ms, fn, ms, options.tolerance ?? 0);
  },

  /** Run `fn` in the next turn. */
  post(fn: () => void): void {
    if (typeof fn !== "function") throw new TypeError("MainLoop.post: a function is required");
    tasks.push(fn);
    if (!turning) signal();
  },

  /** Resolve at least `ms` later, in a main-loop turn. */
  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => addTimer(ms, resolve, 0, 0));
  },

  /** Resolve at the next frame of `view`'s screen, or of the main screen. */
  nextFrame(view?: HasNativeView): Promise<FrameInfo> {
    return new Promise<FrameInfo>((resolve) => {
      subscribe(
        resolve,
        view ? () => lib.br_main_display_of(view.native.ptr) as number : mainDisplay,
        "nextFrame",
        true,
      );
    });
  },

  /** Native counters and the main loop's own, read now. */
  get stats(): MainLoopStats {
    lib.br_main_stats(nativeStats, nativeStats.length);
    const byMode: Record<string, ModeStats> = {};
    const modes = nativeStats[7]!;
    for (let i = 0; i < modes; i++) {
      const s = modeStats(8 + i * 3);
      if (s.count > 0) byMode[modeName(i)] = s;
    }
    const clockList: MainLoopStats["frames"]["clocks"] = [];
    let missed = 0;
    for (const clock of clocks.values()) {
      const m = CF[cf(clock.slot, 4)]!;
      missed += m;
      clockList.push({
        display: clock.display,
        fired: CF[cf(clock.slot, 3)]!,
        missed: m,
        running: CU[cu(clock.slot, 2)] !== 0,
      });
    }
    return {
      nested: {
        count: nativeStats[0]!,
        totalMs: nativeStats[1]!,
        longestMs: nativeStats[2]!,
        fromJavaScript: nativeStats[3]!,
        byMode,
      },
      bun: { longestWaitMs: nativeStats[4]! },
      timers: {
        run: lateness.count,
        p50LatenessMs: lateness.quantile(0.5),
        p99LatenessMs: lateness.quantile(0.99),
        maxLatenessMs: lateness.max,
      },
      turns: {
        count: nativeStats[5]!,
        deferred: nativeStats[6]!,
        p50Ms: turnTimes.quantile(0.5),
        p99Ms: turnTimes.quantile(0.99),
        maxMs: turnTimes.max,
      },
      frames: {
        delivered: framesDelivered,
        missed,
        clocks: clockList,
        views: [...subscribers].map((s) => ({
          name: s.name,
          delivered: s.delivered,
          missed: s.clock ? CF[cf(s.clock.slot, 4)]! - s.missedAt : 0,
        })),
      },
    };
  },

  /** Start the statistics over: counters, lateness and turn times. */
  resetStats(): void {
    lib.br_main_stats_reset();
    lateness.reset();
    turnTimes.reset();
  },

  /** Report every hold of the main thread at least `thresholdMs` long (default 50), when it ends. */
  onStall(fn: (stall: Stall) => void, options: { thresholdMs?: number } = {}): Disposable {
    ensureMainLoop();
    const listener: StallListener = { fn, thresholdMs: Math.max(1, options.thresholdMs ?? 50) };
    stallListeners.add(listener);
    updateStallThreshold();
    const stop = () => {
      stallListeners.delete(listener);
      updateStallThreshold();
    };
    return { dispose: stop, [Symbol.dispose]: stop };
  },
};

/** For tests and tools: the main loop's view of the safe point (§3). */
export function safePointState(): { inPump: number; callbackDepth: number; inTurn: boolean } {
  return { inPump: U[U_IN_PUMP]!, callbackDepth: U[U_CALLBACK_DEPTH]!, inTurn: U[U_IN_TURN] !== 0 };
}
