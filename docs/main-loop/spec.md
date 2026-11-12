# BunKit v2: the main loop

**Status:** proposed, for BunKit v2. **Scope:** `src/runtime.ts`, `native/src/runloop.m`, the
JS→native callback dispatcher in `src/objc.ts`, frame delivery (`onFrame`, `GPUView`),
`src/ui/menu.ts`, `src/ui/dialogs.ts`, `src/net`, and a new `bunkit/thread`.

## Building it

- **On a branch of its own.** Create `main-loop` from `hiettlight/v2` and do all the work there.
  Never commit to or push `hiettlight/v2` directly: hiettlight's `v2` tracks that branch, and it
  stays as it is until this is finished. Push `main-loop` as often as you like.
- **Merged once, when it is done:** every section built, section 13's open questions answered and
  written back into this document, and the tests in section 11 passing. Merge `main-loop` into
  `hiettlight/v2` then, and not before.
- **This repo's rules apply** (`CLAUDE.md`): rebuild the dylib after any change under `native/`
  (`./native/build.sh`); `bun run typecheck` at 0 errors and `bun test` green before every push;
  commits of 12 words or fewer, all lowercase, no body, and no tool attribution or co-author lines.
- **Start with section 13.** Run the experiments in `docs/main-loop/experiments/`, then settle open
  questions 2 (the checkpoint) and 1 (display links) before building anything that depends on
  them. Where a measurement contradicts this spec, the measurement wins: change the spec in the
  same commit.

## Summary

AppKit sometimes takes the main thread and keeps it until a person lets go of the mouse: an open
menu, a live window resize, a slider being dragged, a context menu, a modal session. BunKit v1
gives Bun the main thread and lends it to AppKit in slices, so for as long as AppKit keeps one,
**nothing of Bun's runs**: no timers, no I/O callbacks, no promise continuations, no messages from
workers. Measured: zero of each in a second inside a nested loop (§1.3). Animations freeze,
sockets stall, and work with a deadline stops. In hiettlight the lights of a live show freeze on
their last look while a menu is open.

Bun has no way to run its event loop from inside a native call. It has no equivalent of libuv's
`uv_run(UV_RUN_NOWAIT)`, which is how Electron keeps Node running inside Cocoa's loops. So on
today's Bun, Bun's own loop can't be kept running. v2 does the next-best thing, and does it
correctly:

1. **A main loop of BunKit's own** (§4): timers, tasks, frames and deliveries scheduled on AppKit's
   run loop in its *common modes*, so they run inside every nested loop AppKit enters from event
   dispatch. They run **only at safe points**: when the only JavaScript on the stack is BunKit's
   own pump. Each run is a whole JavaScript turn, microtask checkpoint included.
2. **No nested loop is ever entered with your JavaScript on the stack** (§6). Every BunKit API that
   would enter one becomes asynchronous and starts it from the main loop instead. BunKit detects
   and reports any that slip through.
3. **Threads as a first-class part of BunKit** (§7): workers compiled into the app; a channel from a
   worker to the main thread that the run loop delivers, so it arrives while a menu is open;
   shared cells for values read every frame; and the reverse direction without blocking the
   worker.
4. **Observability** (§8): how long the main thread was held, by what, and how late the main loop
   ran.

Together these keep **JavaScript's run-to-completion guarantee intact** (§3). That guarantee is the
line between this design and the shortcut it replaces.

It is also shaped for the root fix. If Bun gains a way for a host loop to drive its event loop
(Appendix B proposes the API), BunKit inverts ownership: AppKit's loop owns the thread and Bun's is
serviced from it, as Electron does with Node. Bun's own timers and I/O then survive nesting too,
and nothing above the runtime changes (§9).

---

## 1. Background

### 1.1 How v1 runs the main thread

`run()` (`src/runtime.ts`) is the outermost loop on the main thread, and it is JavaScript. Each
iteration:

1. calls `br_pump(seconds)` (`native/src/runloop.m`), which blocks in
   `-[NSApplication nextEventMatchingMask:untilDate:inMode:dequeue:]` in `NSDefaultRunLoopMode`
   for at most `seconds`, dispatches each event with `-sendEvent:`, drains the rest without
   blocking, and calls `-updateWindows`;
2. runs the frame callbacks (`tickFrames`), once per iteration;
3. `await Bun.sleep(0 | idleSleep)`, which gives Bun a turn: timers, I/O, promises, worker messages.

JavaScript wakes a blocked pump with `br_post_empty_event`. AppKit calls into JavaScript
synchronously through one libffi dispatcher (`dispatchCallback` in `src/objc.ts`): delegates,
actions, blocks, data sources.

### 1.2 Nested loops

Some AppKit interactions run a run loop of their own and return only when the interaction ends:

| Interaction | Entered from | Run loop mode |
| --- | --- | --- |
| A menu-bar menu | `-sendEvent:` (mouse down in the menu bar) | `NSEventTrackingRunLoopMode` (measured, E2 shape) |
| A context menu (`+popUpContextMenu:withEvent:forView:`) | the caller: BunKit's `popUpMenu` | `NSEventTrackingRunLoopMode` (E2) |
| Live window resize | `-sendEvent:` | `NSEventTrackingRunLoopMode` |
| Control tracking: `NSSlider`, steppers, scrollers, segmented controls | `-sendEvent:` → the cell's `-trackMouse:…` | `NSEventTrackingRunLoopMode` |
| A modal session (`-runModal…`) | the caller | `NSModalPanelRunLoopMode` |

Both modes are members of the common modes (`kCFRunLoopCommonModes`). Rows not marked measured
are from Apple's documentation, and each gets a test in §11.

What matters is not the mode but **what is on the JavaScript stack when the nesting starts**:

- **Entered from event dispatch.** The stack is `run() → br_pump → [native]`. The only JavaScript
  frame is BunKit's pump, which does nothing across the call.
- **Entered from your JavaScript.** Your code called into AppKit and AppKit nested. Your function
  is suspended mid-statement until the interaction ends.

### 1.3 What runs inside one (measured)

On an M-series Mac, macOS 26, Bun 1.4.4. The scripts are in `docs/main-loop/experiments/`
(Appendix A).

| | Inside the nested loop |
| --- | --- |
| **E1** · a second in `NSEventTrackingRunLoopMode`, entered from JavaScript · an `NSTimer` (10 ms) in the common modes calling JavaScript | **98–99 calls** |
| E1 · Bun `setInterval` (10 ms) | **0** |
| E1 · Bun `setTimeout(…, 0)` queued from inside | **0 of 9** |
| E1 · promise continuations queued from inside | **0**; **98** when the callback calls `drainMicrotasks()` (`bun:jsc`) |
| E1 · a Bun **Worker**'s `setInterval` (10 ms) | **86–92**: unaffected |
| **E2** · a real `NSMenu`, popped up from JavaScript | mode `NSEventTrackingRunLoopMode`; **23–24 calls** of a 10 ms common-modes timer in the ~330 ms it was open (≈33 expected); Bun `setInterval` **0** |
| **E3** · a worker posting a native function to GCD's main queue every 10 ms, during a nested second | posted 85–92, **delivered 110–119** (posts queued before the loop as well), **all on the main thread** |
| **E4** · `Atomics.waitAsync` in Bun | works: a 20 ms `Atomics.notify` woke it at 21 ms |
| **E5** · `-[NSView displayLinkWithTarget:selector:]` and `-[NSScreen displayLink…]` in the common modes, from a bare process | **no callbacks in any mode**, window visible: unexplained, open question 1 (§13) |

Surveyed: Bun exposes nothing that steps or wakes its event loop. It has `Bun.sleep`,
`Bun.sleepSync`, and `bun:jsc`'s `drainMicrotasks`. `process._tickCallback` exists, and
`bun:internal-for-testing` is not available. A bun:ffi `threadsafe` callback is delivered by the
receiving thread's Bun loop, so `bunkit/net`'s deliveries stall during nesting too (by
construction, to be pinned by a test).

Three conclusions shape everything below:

- **Native → JavaScript calls work inside any nested loop.** A run-loop source or timer in the
  common modes reaches JavaScript.
- **Bun's own loop does not run, and nothing on today's Bun can make it.**
- **A worker's loop is untouched**, and the run loop can carry work from a worker to the main thread
  while nested.

### 1.4 Why v1's "live with it" is not good enough

The v1 README's position is that menus and resizes are "bounded by someone letting go of the
mouse". That holds for a document editor. It does not hold for:

- an app that animates: views freeze for the whole resize, which no native app does;
- an app that talks to the network: peers time out on a stalled reader;
- an app with deadlines. hiettlight renders a live show's lighting every 10 ms, and dragging a
  fader to dim the rig must not stop the rig.

---

## 2. Goals and non-goals

**Goals**

- **G1.** JavaScript's run-to-completion guarantee is never weakened (§3). This is the
  non-negotiable one.
- **G2.** Work scheduled on BunKit's main loop runs through every nested loop that AppKit enters
  from event dispatch.
- **G3.** Views keep drawing at their display's rate through live resize, menus and control
  tracking.
- **G4.** Work that must never stop has a supported home off the main thread, with a path to and
  from the UI that works during nesting.
- **G5.** BunKit says when the main thread was held, for how long, and by what.
- **G6.** The public API survives the switch to a Bun-hosted loop (§9) unchanged.

**Non-goals**

- Running Bun's own timers and I/O during nesting on today's Bun. It is impossible, and §9 is the
  route to it.
- Moving UI JavaScript off the main thread (§10).
- Real-time guarantees on the main thread. The main loop is a UI clock. Deadline work belongs on
  a thread (§7) or in native code.

---

## 3. The invariant

> **A main-loop turn never begins while any of your JavaScript is on the stack.**

A *turn* begins with no application JavaScript on the stack and ends with a microtask checkpoint,
as an HTML event-loop task does. The one exception is the one every AppKit binding has, and v1
has: AppKit calls a delegate, action or data source *synchronously* during a call your
JavaScript made into it. v2 adds no new exception.

The invariant is expressed with two pieces of state:

- **`inPump`** (native): set by `br_pump` for its whole duration. While it is set, the only
  JavaScript frame below native code is BunKit's `run()`, which is inert across the call.
- **`callbackDepth`** (shared): incremented and decremented around every native → JavaScript
  entry: `dispatchCallback`, blocks, and every `JSCallback` BunKit creates (net, video, metal,
  the main loop itself). It is kept in memory that both sides read, a `Uint32` view over a native
  static, so maintaining it costs no FFI call.

> **Safe point** ≡ `inPump && callbackDepth == 0 && !inTurn`

Why this is exactly right:

- **Nesting from event dispatch** (menus, resize, slider drags) happens under `br_pump`. Between
  the action and delegate callbacks AppKit makes inside it, depth returns to 0, so the main loop
  runs there. Your code is not mid-way through anything: the only frame is the pump.
- **Nesting started by your JavaScript** never produces a safe point. Called from a Bun timer or
  promise, `inPump` is false. Called from inside a callback, `callbackDepth ≥ 1`. The main loop
  waits until the call returns, so your function finishes before anything else of yours runs.
  §6 makes this case not happen.

The shortcut, a common-modes timer calling JavaScript unconditionally, is what E1 measures: 98
callbacks ran while the JavaScript function that entered the loop was still mid-statement. That is
run-to-completion broken, and the bugs it causes are intermittent, timing-dependent, and found on
show night. It is rejected (§10).

---

## 4. The main loop

### 4.1 Native side (`runloop.m`)

On the main run loop, all in `kCFRunLoopCommonModes`:

- **the work source**: one version-0 `CFRunLoopSource`, signalled whenever there is work: a posted
  task, a channel message (§7), a frame (§5);
- **the deadline timer**: one `CFRunLoopTimer`, re-armed to the earliest due main-loop timer;
- **the frame clocks** (§5).

When the source or the timer fires:

1. **At a safe point:** call the single JavaScript entry, `turn()`, which is a `JSCallback` that
   counts in `callbackDepth`.
2. **Not at a safe point:** set `pendingTurn` and return. `br_pump` runs a pending turn at its next
   safe point: after each `-sendEvent:` returns and before it returns to JavaScript.

`br_main_signal()` is `CFRunLoopSourceSignal` followed by `CFRunLoopWakeUp`. Both are documented
thread-safe, and the signal is callable from any thread: workers (§7), native subsystems
(`net.m`), and JavaScript on the main thread (`MainLoop.post`). Signals coalesce: one turn drains
everything pending.

### 4.2 A turn (`src/runtime.ts`)

```
turn():
  inTurn = true
  repeat until no work or the turn's budget is spent:
    run each due timer (earliest deadline first), then each posted task (FIFO),
      then drain each channel (§7.2) and run due frames (§5);
    after every callback: checkpoint — the nextTick queue, then microtasks
  re-arm the deadline timer (CFRunLoopTimerSetNextFireDate) — one FFI call
  if work remains: br_main_signal()      // yield to AppKit, come straight back
  inTurn = false
```

- **Checkpoint after every callback**, as the HTML event loop does after every task. The candidates
  are `process._tickCallback()` (nextTick, then microtasks) and `drainMicrotasks()`. Which one
  covers both queues in Bun's order is open question 2.
- **A budget per turn** (default 8 ms) stops a flood of work from starving AppKit's own event
  handling inside a menu. The remainder runs in the next turn, signalled before yielding.
- **Exceptions** in a callback are caught, reported with their stack, and never unwind into
  Objective-C, as `dispatchCallback` already guarantees.

### 4.3 API (`bunkit/runtime`)

```ts
export const MainLoop: {
  /** Run `fn` once, at least `ms` later. */
  after(ms: number, fn: () => void): Disposable;
  /** Run `fn` every `ms`, never early, coalescing missed runs into one. */
  every(ms: number, fn: () => void, options?: { tolerance?: number }): Disposable;
  /** Run `fn` in the next turn. */
  post(fn: () => void): void;
  /** Resolve at least `ms` later, in a main-loop turn. */
  sleep(ms: number): Promise<void>;
  /** Resolve at the next frame of `view` (or of the main screen). */
  nextFrame(view?: View): Promise<FrameInfo>;
  readonly stats: MainLoopStats;                       // §8
  onStall(fn: (stall: Stall) => void, options?: { thresholdMs?: number }): Disposable;
};
```

- **Deliberately not `setTimeout`.** These run inside nested loops and Bun's timers don't; one name
  for two behaviours is how an app ends up with half its timers frozen. Globals are never patched
  (§10).
- **Timing.** These are never early and may be late. Inside a real menu, a 10 ms timer ran about
  70 times a second (E2): AppKit sets the pace while it tracks. This is a UI clock. Deadlines
  belong on a thread (§7).
- **`Disposable`**: `using t = MainLoop.every(…)` stops it at the end of the scope.

### 4.4 Interaction with Bun's loop

On today's Bun, Bun stays outermost and runs between pump slices exactly as in v1. Main-loop
turns run inside pump slices, nested or not. While Bun is running JavaScript, a due main-loop
timer waits for the next slice, which is at most `pumpSeconds` (4 ms) away while active.

**No ordering is guaranteed between a Bun task and a main-loop task.** They are two queues. An
ordered stream uses one of them; the channel (§7.2) is the one that survives nesting.

---

## 5. Frames

Frame callbacks (`onFrame`, `GPUView`'s frames) move from "once per pump iteration" to **the
display's clock**, and are delivered as main-loop turns. Views keep drawing through live resize,
menus and slider drags, each paced by its own screen: a window on a 60 Hz external display draws
at 60, and on a ProMotion panel at up to 120.

- **Clock source, in order of preference:**
  1. `-[NSView displayLinkWithTarget:selector:]` (macOS 14+), added to the common modes. E5 saw no
     callbacks from a bare process in any mode, so it is not relied on until open question 1 is
     answered.
  2. A common-modes `CFRunLoopTimer` at the screen's refresh interval
     (`NSScreen.maximumFramesPerSecond`), with `CAMetalLayer`'s own vsync pacing deciding when a
     drawable is shown. This fires inside tracking (E1, E2).
  3. `CVDisplayLink` (deprecated) on its own thread, signalling the work source.
- **Live resize:** from `-viewWillStartLiveResize` to `-viewDidEndLiveResize`, a Metal view sets
  `presentsWithTransaction = YES` and draws in the turn that follows each size change, so the
  drawable matches the window. No stretched frames.
- **Idle:** the clock runs only while something animates. The `setAnimating` refcount is kept, so
  an idle app has no wakeups.
- `onFrame(fn)` keeps its signature, and the callback gets
  `{ timestamp, targetTimestamp, duration }`.

---

## 6. No nested loop with your JavaScript on the stack

### 6.1 Policy

BunKit's APIs never start a nested run loop from your call. An API that would is asynchronous and
**trampolined**: BunKit posts a native work item, and the work source's *native* callback makes
the synchronous AppKit call. The nesting then starts under the pump with no frame of yours on the
stack: a nested loop "from event dispatch" in the terms of §1.2, inside which the main loop keeps
running. The promise resolves in the turn after the AppKit call returns.

| v1 | v2 |
| --- | --- |
| `popUpMenu(items, view)` calls `+popUpContextMenu:withEvent:forView:` synchronously | `popUpMenu(items, view): Promise<MenuItem \| undefined>` |
| `alert`/`prompt` fall back to `-runModal` with no window on screen | always hung from a host window as a sheet; `-runModal` is unreachable from BunKit |
| (future) any `-runModal…`, `-popUpMenuPositioningItem:…`, `NSSavePanel -runModal`, `NSPrintOperation -runOperation` | asynchronous and trampolined when wrapped |

### 6.2 Detection

A `CFRunLoopObserver` for `kCFRunLoopEntry | kCFRunLoopExit`, in the common modes, keeps the
nesting depth. A nested entry while the main thread is not at a safe point means your JavaScript
started it, through BunKit's raw `objc` layer. BunKit then:

- records the mode, and the time until the matching exit;
- in development builds, captures the JavaScript stack at entry. That is a side-effect-free
  `new Error().stack` from the observer, the one JavaScript allowed to run off a safe point, and
  only in development.
- reports at the next safe point, once per call site:
  `[bunkit] AppKit ran a nested run loop (NSModalPanelRunLoopMode) for 820 ms while JavaScript
  was on the stack, from …. The main loop waited. Use the asynchronous API instead.`

### 6.3 What the raw layer can still do

`objc.*` (layer 2) stays unrestricted: it is the escape hatch. Calling a synchronous nesting API
through it is correct, keeps run-to-completion, and pauses the main loop for its duration. §6.2
makes that visible rather than silent.

---

## 7. Threads

A thread's Bun loop is untouched by anything AppKit does (E1: 86–92 of ~100 ticks during a nested
second). Work that must not stop (deadlines, networking, anything a person is waiting on) belongs
on one. v2 makes that the easy path.

### 7.1 `bunkit/thread`

```ts
const show = spawnThread(new URL("./show.ts", import.meta.url), { name: "show" });
show.channel.send({ kind: "load", path });             // to the thread, §7.3
show.channel.onMessage((m) => …);                      // from it, §7.2: arrives during a menu
const safety = show.cell(SafetyLayout, "write");       // a shared cell, §7.4
```

- **Compiled in.** The bundler's `workers` option already compiles worker entries into the
  `.app`. `spawnThread` resolves the same URL from source and from the bundle.
- **Lifecycle.** Threads are terminated on quit, after the quit handlers, against one deadline:
  a stuck thread is abandoned, never waited for forever. An uncaught error in a thread reaches the
  main thread through its channel, with its stack, and the thread is not restarted silently.
- **Native libraries.** `bun:ffi` in a thread opens the same dylibs into the same process. Whether
  a library may be called from two threads is the library's contract, and `bunkit/thread`
  documents it rather than assuming it (open question 4).

### 7.2 Thread → main: the channel

- **Transport:** one single-producer, single-consumer ring per thread, in a `SharedArrayBuffer`.
  The producer writes a framed message (length, then bytes), publishes it with
  `Atomics.store(tail)`, and calls `br_main_signal()` through `bun:ffi`. It calls only when the
  consumer has armed an `idle` flag, so a busy stream costs one signal per turn, not per message.
- **Delivery:** the work source drains every ring in a turn, in order per ring, and dispatches to
  `onMessage`. It is delivered by the run loop, so **it arrives during menus, resizes and drags**.
  E3 shows the run loop carrying work from a thread to main-thread JavaScript inside a nested loop.
  v2 uses its own source rather than GCD's main queue: signals coalesce, nothing is allocated per
  message, ordering is the ring's, and nothing interleaves with unrelated GCD work.
- **Why not `postMessage`:** it is delivered by the main thread's Bun loop, which is stopped while
  AppKit nests.
- **Encoding:** a compact binary codec (structured-clone-compatible values) with fast paths for
  typed arrays. A large payload goes in a shared arena and is passed by handle.
- **Backpressure** is chosen per channel: `drop-oldest` (telemetry), `fail` (the caller decides),
  or `wait` (bounded `Atomics.wait`, off the main thread only).

### 7.3 Main → thread

The same ring in the other direction. The thread waits with `Atomics.waitAsync` (E4), which keeps
its own loop running. `postMessage` would also work, since the thread's loop is free, but one
mechanism keeps ordering and backpressure the same both ways. The channel API hides which is used.

### 7.4 Shared cells

A `SharedCell<Layout>` is a fixed layout over a `SharedArrayBuffer` with **one writer** (enforced:
`"write"` and `"read"` handles) and a **seqlock**. The version is odd while being written, and a
reader retries until it reads the same even version twice. It is for values read every frame or
needed at once: a playhead `{ frame, hostTime }`, safety switches, the latest status of a device.
The latest value wins. There are no messages, and no latency beyond the reader's next read. The
main thread reads it in a frame, and a thread reads it in its own clock.

### 7.5 `bunkit/net`

v1 delivers messages through a `threadsafe` bun:ffi callback, so through the receiving thread's
Bun loop, which on the main thread stalls during nesting. In v2, `net.m` writes received messages
into a native ring and signals the work source, the same mechanism as §7.2. A peer's messages are
delivered on the main thread during a menu. Used from a thread, its deliveries run on that
thread's loop as before.

---

## 8. Observability

`MainLoop.stats`, which is native counters read on demand:

- **nested loops:** count, total, longest, by mode, and how many started from your JavaScript (§6.2);
- **Bun starvation:** the longest gap between two Bun turns on the main thread;
- **main-loop lateness:** timers' p50, p99 and max lateness; turns' p99 and max duration;
- **frames:** per view, delivered and missed.

`MainLoop.onStall(fn, { thresholdMs })` reports a stall when it ends: its duration, mode and
origin. An app can show it, as hiettlight does with late lighting frames.

---

## 9. Bun integration: the root fix

With an API in Bun for a host loop to drive Bun's event loop (Appendix B), BunKit inverts
ownership:

- `run()` hands Bun's outer loop to the host and runs `-[NSApplication run]`. AppKit owns the main
  thread.
- Bun's loop is serviced from a common-modes run-loop source. A helper thread waits on Bun's
  poll descriptor with Bun's timer deadline and signals the source, whose turn runs one
  non-blocking iteration of Bun's loop. This is Electron's design (`uv_backend_fd`,
  `uv_backend_timeout`, `uv_run(UV_RUN_NOWAIT)`).
- Bun's own timers, I/O, promises and `postMessage` then run through every nested loop entered from
  event dispatch.

What stays the same: the invariant (§3) and the policy (§6), which are what make *hosting*
correct. A Bun iteration is a turn, and a turn begins only at a safe point. `MainLoop` becomes a
thin layer over Bun's timers, with the same API (G6). Threads (§7) stay the home for deadline work,
because hosting fixes nesting, not a busy UI thread.

---

## 10. Alternatives considered

- **Move UI JavaScript off the main thread.** AppKit stays on the main thread, and the app's
  JavaScript runs in a worker with every AppKit call marshalled across. This is the Java AWT and
  JavaFX model, and React Native's old bridge. Rejected:
  - AppKit asks for synchronous answers: `windowShouldClose:`, data sources during layout,
    `validateMenuItem:` while a menu opens. The main thread would wait on JavaScript while
    JavaScript waits on the main thread. AWT on macOS spent years on exactly these deadlocks.
  - Every AppKit call, about 84 ns today, would become a cross-thread round trip.
  - BunKit's reason to exist is synchronous, real AppKit, and Apple's own model is UI on the main
    thread with work elsewhere, which is §7.
- **Run AppKit on a second stack (fibers) and switch back to Bun mid-nesting.** Rejected:
  - autorelease pools are per-thread stacks that must pop in order;
  - JavaScript called back from AppKit would run on a stack JavaScriptCore's overflow checks and
    conservative garbage-collector scan don't know;
  - an exception unwinding across a stack switch is undefined.
- **Patch the global `setTimeout`, `setInterval` and `queueMicrotask` to run on the run loop.**
  Rejected: it changes Bun's and Node's timer semantics (`ref`, `unref`, `refresh`,
  `Bun.sleep`) for every library in the process, invisibly. `MainLoop` is explicit instead.
- **Main-loop callbacks without the safe-point rule.** Rejected (§3): E1 shows them running while
  the JavaScript that entered the loop was mid-statement.
- **Keep v1's position, live with it.** Rejected (§1.4).

---

## 11. Testing

All in BunKit's suite, one process per suite as now:

1. **Nesting from event dispatch.** For each of: a context menu popped up through the trampoline
   (`popUpMenu`, cancelled from a main-loop timer), a synthesized live resize, a synthesized slider
   drag, and a modal session:
   - main-loop timers deliver ≥ 90 % of nominal (≥ 60 % inside menus, per E2);
   - frames are delivered;
   - channel messages from a thread arrive, in order;
   - a thread's own timers are unaffected.
2. **Run-to-completion.** JavaScript enters a nesting through the raw layer, with a main-loop timer
   due. Assert no turn ran before the call returned, the turn runs after it, and §6.2 reported it
   once with the call site.
3. **Checkpoint.** A promise and a `process.nextTick` queued in a turn inside a nested loop both run
   before the next turn, nextTick first.
4. **Channel.** Ordering, coalesced signals, backpressure modes, a thread terminating with messages
   in flight, and a message larger than the ring through an arena.
5. **Cells.** Torn reads are impossible under a writer hammering a multi-word value (seqlock).
6. **Frames.** Pacing per screen, live resize without stretched frames, and no wakeups while
   nothing animates (idle CPU equal to v1's, measured).
7. **Soak** (`test/soak.ts`): sources, timers, rings and callbacks are freed. No growth over an
   hour of signals.
8. **Performance** (`test/perf.ts`): the pump's per-iteration cost and event latency are no worse
   than v1's, and a turn's fixed cost is measured and written in the code.

---

## 12. Migration from v1

| v1 | v2 |
| --- | --- |
| `onFrame` once per pump iteration | on the display's clock, through live resize and menus |
| `popUpMenu(…): void` | `popUpMenu(…): Promise<MenuItem \| undefined>` |
| dialogs' `-runModal` fallback | removed |
| `bunkit/net` delivered by Bun's loop | delivered by the main loop |
| `setInterval` for UI refresh | `MainLoop.every`, which keeps running during menus |
| — | `bunkit/thread`, `MainLoop`, `MainLoop.stats` |

`run()`, `pumpOnce`, `setAnimating`, `onQuit` and the rest of the runtime keep their contracts.

---

## 13. Open questions (answer before building on them)

1. **Display links (E5).** Why no callbacks came from `NSView` or `NSScreen` display links in a
   bare process, in any mode. Until answered, frames use the run-loop timer (§5, option 2).
2. **The checkpoint in Bun.** Whether `process._tickCallback()` drains the nextTick queue and then
   microtasks in Bun's order, or whether `drainMicrotasks()` must follow it. Settle it with test 3
   first.
3. **Calling into JavaScript from a run-loop source during a modal session and during live resize.**
   AppKit holds no lock JavaScript could re-enter, but this is to be verified per mode by test 1.
4. **`bun:ffi` and `JSCallback` in threads under load.** Lifetimes across threads, termination with
   calls in flight, and an hour's soak. A library's own thread-safety (hiettlight's Rust runtime,
   for one) is that library's question.
5. **`callbackDepth` coverage.** Audit every native → JavaScript entry (`dispatchCallback`, blocks,
   `net`, `video`, `metal`). One that doesn't count is a safe point that isn't one.

---

## Appendix A: the experiments

In `docs/main-loop/experiments/`, run with `bun <file>` from that folder:

| Script | Measures |
| --- | --- |
| `nested.ts` (+ `worker.ts`) | E1: a second in `NSEventTrackingRunLoopMode` entered from JavaScript. Common-modes timer calls, Bun timers and timeouts, promise continuations, a worker. `bun nested.ts drain` repeats it with `drainMicrotasks()`. |
| `menu.ts` | E2: a real `NSMenu`, its mode, and what runs while it's open (it pops up on screen for a moment). |
| `deliver.ts` (+ `poster.ts`) | E3: a worker putting a main-thread function on GCD's main queue during a nested second. |
| `displaylink.ts` | E5: display-link callbacks in the default and tracking modes (none, so far). |

E4 is one line:
`const a = new Int32Array(new SharedArrayBuffer(4)); Atomics.waitAsync(a, 0, 0, 1000).value.then(…); setTimeout(() => Atomics.notify(a, 0), 20)`.

## Appendix B: an API for Bun

What BunKit needs from Bun is what libuv gives Electron: a way for a host's loop to own the thread
and drive Bun's.

```ts
/**
 * Hand Bun's outer event loop to a host for as long as `host` runs. `host` runs the host's own
 * loop and returns when it ends; Bun's loop resumes then. While it runs, Bun's loop does nothing
 * by itself: the host drives it with `Bun.unstable_eventLoop`.
 */
Bun.unstable_hostEventLoop(host: () => void): void;

Bun.unstable_eventLoop: {
  /** A descriptor that becomes readable when Bun's loop has I/O ready (its kqueue, on macOS). */
  readonly pollFd: number;
  /** Milliseconds until Bun's next timer: −1 for none, 0 for work ready now. */
  timeoutMs(): number;
  /**
   * One non-blocking iteration: due timers, ready I/O, immediates, tasks, then the microtask
   * checkpoint. Callable only from a host callback while the loop is handed over, with no
   * JavaScript on the stack (BunKit's safe point).
   */
  runOnce(): void;
};
```

The host side is Electron's `NodeBindingsMac`: a helper thread `kevent`s on `pollFd` with
`timeoutMs()`, then signals a common-modes run-loop source, whose callback calls `runOnce()`.
The alternative shape is a macOS-only option for Bun to back its own loop with `CFRunLoop`,
registering its descriptor and timers in the common modes, as Qt's Core Foundation dispatcher
does. That is less general than a host API, which also serves GLib on Linux and the Win32 message
loop. To be raised with Bun as an issue, with this document and E1–E3 as the evidence.

## Appendix C: what hiettlight does with it

The problem that started this, a live show's lighting freezing while a menu is open, is solved
by §7, not by §4. The show is deadline work, and deadline work leaves the UI thread:

- **The show thread.** The project's show and its clock move to a thread (`spawnThread`). Its Bun
  loop never stops, so menus, resizes, fader drags, a slow layout or a garbage-collection pause on
  the UI side can't stall the lighting. It commits frames to the Rust runtime from there. Whether
  the runtime may be called from a second JavaScript thread is checked against its locks first.
- **Safety in shared cells.** Live, Haze, Mover Motion and the Masters are a `SharedCell` the UI
  writes and the show thread reads every frame, so a switch takes effect on the next frame, as it
  does today, with no message in between.
- **The channel** carries the cue stack, faults and the rig description to the UI. The visualizer
  keeps reading the DMX frame from Rust.
- **The phone server and the remote transport** move to threads, so their sockets keep running
  through a menu.
- **The UI's own refreshes** (the status list, Now Playing, the toolbar) run on `MainLoop.every`,
  so they keep updating during a menu.
- The main-thread budgets written around the show ("the turn is the lighting's") can be retired.
