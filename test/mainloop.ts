// The main loop (src/mainloop.ts, native/src/mainloop.m; docs/main-loop/spec.md §11, tests 1, 2,
// 3 and 6).
//
// 1. Nesting from event dispatch. A context menu popped up through the trampoline and cancelled
//    from a main-loop timer, a synthesized live resize, a synthesized slider drag, and a modal
//    session started through the trampoline and stopped from a main-loop timer. In each: main-loop
//    timers deliver at least 90% of nominal (60% inside menus), frames are delivered, a thread's
//    messages arrive in order, and its own timers are unaffected. And a peer's net messages are
//    delivered during a menu.
// 2. Run-to-completion. JavaScript enters a nested loop through the raw layer with a main-loop
//    timer due: no turn runs before the call returns, the turn runs after it, and the nesting is
//    reported, once per call site.
// 3. The checkpoint. A promise and a process.nextTick queued in a turn inside a nested loop both
//    run before the next turn, nextTick first.
// 6. Frames. Each screen's frames come at its own rate; a live resize draws without a stretched
//    frame; and while nothing animates there are no wakeups, and idle CPU is v1's.
//
// Everything runs inside run(), as an app does. The menus and the resize are real: they appear on
// screen for a moment, driven by events posted to the app's own queue.

import { globalObject, objc, sendFromPump } from "../src/objc.ts";
import { initApp, MainLoop, onFrame, quit, run, type Stall } from "../src/runtime.ts";
import { nestingReports, onViewFrame } from "../src/mainloop.ts";
import { Menu, popUpMenu } from "../src/ui/menu.ts";
import { Window } from "../src/ui/window.ts";
import { View } from "../src/ui/view.ts";
import { GPUView, gpuAvailable } from "../src/metal/index.ts";
import { spawnThread } from "../src/thread.ts";
import { Ticker } from "./fixtures/thread-layouts.ts";
import { PeerConnection, PeerListener } from "../src/net/index.ts";

let failures = 0;
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const CI = !!Bun.env.CI;
initApp();
const app = objc.NSApplication.sharedApplication();
app.activateIgnoringOtherApps_(true);

/** Resolve after `ms`, in a main-loop turn: keeps running inside nested loops, unlike Bun.sleep. */
const sleep = (ms: number) => MainLoop.sleep(ms);

/** Wait, in main-loop time, until `cond` holds or `ms` pass. */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) return false;
    await sleep(5);
  }
  return true;
}

// ---------------------------------------------------------------------------
// What every nesting scenario measures
// ---------------------------------------------------------------------------

const thread = spawnThread(new URL("./fixtures/thread-worker.ts", import.meta.url), { name: "ticker" });
const fromThread: Array<{ tick: number; own: number; at: number }> = [];
thread.channel.onMessage((m: any) => {
  if (m?.tick !== undefined) fromThread.push({ ...m, at: performance.now() });
});
const ticker = thread.cell(Ticker, "read");

let timerRuns = 0;
const timerHandle = MainLoop.every(10, () => timerRuns++);
let frames = 0;
const stopFrames = onFrame(() => frames++);

interface Window_ {
  ms: number;
  timer: number;
  frames: number;
  messages: Array<{ tick: number; own: number }>;
  threadOwn: number;
  nested: Record<string, { count: number; totalMs: number }>;
}

/** Run `scenario`, and report what the main loop and the thread did while it ran. */
async function measure(scenario: () => Promise<void>): Promise<Window_> {
  const nestedBefore = MainLoop.stats.nested.byMode;
  const start = { t: performance.now(), timer: timerRuns, frames, messages: fromThread.length, own: ticker.read().own };
  await scenario();
  const ms = performance.now() - start.t;
  const nestedAfter = MainLoop.stats.nested.byMode;
  const nested: Window_["nested"] = {};
  for (const [mode, s] of Object.entries(nestedAfter)) {
    const before = nestedBefore[mode] ?? { count: 0, totalMs: 0 };
    if (s.count > before.count) nested[mode] = { count: s.count - before.count, totalMs: s.totalMs - before.totalMs };
  }
  return {
    ms,
    timer: timerRuns - start.timer,
    frames: frames - start.frames,
    messages: fromThread.slice(start.messages),
    threadOwn: ticker.read().own - start.own,
    nested,
  };
}

/** The checks every scenario gets. `share` is the main-loop timers' floor: 0.9, or 0.6 in menus. */
function checkWindow(what: string, w: Window_, share: number, nestedMode?: string): void {
  const nominal = w.ms / 10;
  console.log(
    `  (${what}: ${w.ms.toFixed(0)} ms; timer ${w.timer}/${nominal.toFixed(0)}, ${w.frames} frames, ` +
      `${w.messages.length} messages from the thread, its own timer ${w.threadOwn}; nested ${JSON.stringify(w.nested)})`,
  );
  if (nestedMode) {
    check(`${what}: AppKit ran a nested loop in ${nestedMode}`, (w.nested[nestedMode]?.count ?? 0) >= 1, w.nested);
  }
  check(`${what}: main-loop timers ran ≥ ${share * 100}% of nominal`, w.timer >= nominal * (CI ? share * 0.6 : share), `${w.timer} of ${nominal.toFixed(0)}`);
  check(`${what}: frames were delivered`, w.frames >= (w.ms / 1000) * 30, w.frames);
  const ticks = w.messages.map((m) => m.tick);
  check(`${what}: the thread's messages arrived, in order`, ticks.length >= (w.ms / 5) * 0.5 && ticks.every((t, i) => i === 0 || t === ticks[i - 1]! + 1), ticks.length);
  check(`${what}: the thread's own timer was unaffected`, w.threadOwn >= (w.ms / 5) * 0.7, w.threadOwn);
}

const window = new Window({ title: "main loop", size: { width: 420, height: 300 }, show: true });
const windowNumber = Number(window.native.windowNumber());

function mouse(type: number, x: number, y: number) {
  return objc.NSEvent.mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
    type, { x, y }, 0, objc.NSProcessInfo.processInfo().systemUptime(), windowNumber, null, 0, 1, 1,
  );
}

/** Post a mouse-down at `from`, drags towards `to` every 16 ms from main-loop timers, then a mouse-up. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }, steps: number): Promise<void> {
  app.postEvent_atStart_(mouse(1, from.x, from.y), false);
  let step = 0;
  await new Promise<void>((resolve) => {
    const t = MainLoop.every(16, () => {
      step++;
      const k = Math.min(1, step / steps);
      const x = from.x + (to.x - from.x) * k;
      const y = from.y + (to.y - from.y) * k;
      if (step <= steps) {
        app.postEvent_atStart_(mouse(6, x, y), false);
      } else {
        app.postEvent_atStart_(mouse(2, x, y), false);
        t.dispose();
        resolve();
      }
    });
  });
}

const stalls: Stall[] = [];
MainLoop.onStall((s) => stalls.push(s), { thresholdMs: 100 });

async function main(): Promise<void> {
  thread.channel.send({ cmd: "tick", ms: 5 });
  await until(() => fromThread.length > 20 && ticker.read().own > 0, 5000);
  await sleep(300); // past the window's first appearance

  // -------------------------------------------------------------------------
  // 1. Nesting from event dispatch
  // -------------------------------------------------------------------------
  {
    // A context menu, popped up through the trampoline, cancelled from a main-loop timer.
    const menu = Menu.from([{ title: "One" }, { title: "Two" }]);
    let cancelledInTurn = false;
    const w = await measure(async () => {
      MainLoop.after(600, () => {
        cancelledInTurn = true;
        menu.native.cancelTracking();
      });
      const chosen = await popUpMenu(menu, window);
      check("context menu: dismissed, it resolves with no item", chosen === undefined, chosen);
    });
    check("context menu: cancelled from a main-loop timer, while open", cancelledInTurn);
    checkWindow("context menu", w, 0.6, "NSEventTrackingRunLoopMode");
    check("context menu: one stall reported, from event dispatch, in the tracking mode", stalls.some((s) => s.origin === "event" && s.mode === "NSEventTrackingRunLoopMode" && s.durationMs >= 500), stalls);
  }
  {
    // A context menu whose item is chosen: its onClick runs, and the promise resolves with it.
    let clicked = 0;
    const items = [{ title: "First" }, { title: "Second", onClick: () => clicked++ }];
    const menu = Menu.from(items);
    MainLoop.after(300, () => {
      const item = menu.native.itemAtIndex_(1);
      menu.native.performActionForItemAtIndex_(1);
      menu.native.cancelTracking();
      void item;
    });
    const chosen = await popUpMenu(menu);
    check("context menu: a chosen item's onClick runs, and the promise resolves with its spec", clicked === 1 && chosen === items[1], { clicked, chosen: chosen?.title });
  }
  {
    // A live resize, synthesized: a drag from the window's bottom-right corner.
    let live = 0;
    const start = globalObject("NSWindowWillStartLiveResizeNotification");
    const center = objc.NSNotificationCenter.defaultCenter();
    const observer = center.addObserverForName_object_queue_usingBlock_(start, window.native, null, () => live++);
    const frame = window.native.frame();
    const width = Number(frame.width);
    const before = { width, height: Number(frame.height) };
    const w = await measure(async () => {
      await drag({ x: width - 2, y: 2 }, { x: width + 140, y: -90 }, 30);
      await sleep(50);
    });
    center.removeObserver_(observer);
    const after = window.native.frame();
    check("live resize: it happened, as a live resize", live === 1 && Number(after.width) > before.width + 50, { live, before, after: { width: after.width, height: after.height } });
    checkWindow("live resize", w, 0.9, "NSEventTrackingRunLoopMode");
  }
  {
    // A slider drag, synthesized: a mouse-down on the knob and drags along the track.
    const slider = objc.NSSlider.sliderWithValue_minValue_maxValue_target_action_(0, 0, 100, null, null);
    slider.setFrame_({ x: 20, y: 20, width: 360, height: 30 });
    window.native.contentView().addSubview_(slider);
    await sleep(100);
    const w = await measure(async () => {
      await drag({ x: 30, y: 35 }, { x: 370, y: 35 }, 30);
      await sleep(50);
    });
    check("slider drag: the knob moved", Number(slider.doubleValue()) > 50, Number(slider.doubleValue()));
    // Measured on macOS 26: NSSlider tracks a drag with ordinary events, without a nested loop.
    console.log(`  (slider drag: nested loops ${JSON.stringify(w.nested)})`);
    checkWindow("slider drag", w, 0.9);
    slider.removeFromSuperview();
  }
  {
    // A modal session, started through the trampoline, stopped from a main-loop timer — and the
    // checkpoint (test 3) inside it.
    const panel = objc.NSPanel.alloc().initWithContentRect_styleMask_backing_defer_({ x: 400, y: 400, width: 240, height: 120 }, 1, 2, false);
    panel.setReleasedWhenClosed_(false);
    const order: string[] = [];
    let stopped = false;
    const w = await measure(async () => {
      MainLoop.after(200, () => {
        process.nextTick(() => order.push("nextTick"));
        Promise.resolve().then(() => order.push("promise"));
        order.push("callback");
      });
      MainLoop.after(200, () => order.push("next turn's callback"));
      MainLoop.after(700, () => {
        stopped = true;
        app.stopModal();
      });
      const response = await sendFromPump(app, "runModalForWindow:", panel);
      check("modal session: runModalForWindow: returned NSModalResponseStop", Number(response) === -1000, response);
    });
    panel.orderOut_(null);
    check("modal session: stopped from a main-loop timer, inside it", stopped);
    checkWindow("modal session", w, 0.9, "NSModalPanelRunLoopMode");
    check(
      "checkpoint: a promise and a nextTick queued in a turn inside a nested loop both run before the next callback, nextTick first",
      order.join(",") === "callback,nextTick,promise,next turn's callback",
      order,
    );
  }
  {
    // A peer's messages are delivered during a menu: sent from main-loop timers, inside it.
    const listener = new PeerListener({ type: `_bkml${process.pid % 10000}._tcp`, name: "main loop", advertise: false });
    const received: number[] = [];
    listener.onConnection((c) => c.onMessage((m) => received.push(new DataView(m.buffer, m.byteOffset).getUint32(0, true))));
    const port = await listener.started();
    const conn = PeerConnection.connect({ host: "127.0.0.1", port });
    await conn.opened();
    const menu = Menu.from([{ title: "One" }]);
    let n = 0;
    let duringMenu = 0;
    let open = false;
    const sender = MainLoop.every(20, () => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n++, true);
      void conn.send(b);
    });
    const counter = MainLoop.every(50, () => {
      if (open) duringMenu = received.length;
    });
    MainLoop.after(500, () => menu.native.cancelTracking());
    const at = received.length;
    open = true;
    await popUpMenu(menu);
    open = false;
    sender.dispose();
    counter.dispose();
    await until(() => received.length >= n, 2000);
    check(`net: a peer's messages are delivered during a menu (${duringMenu - at} while it was open)`, duringMenu - at >= 10, { at, duringMenu });
    check("net: in order, none lost", received.length === n && received.every((v, i) => v === i), received.length);
    conn.close();
    listener.close();
  }

  // -------------------------------------------------------------------------
  // 2. Run-to-completion
  // -------------------------------------------------------------------------
  {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    const reportsBefore = nestingReports.length;
    let ran = 0;
    let ranDuringCall = -1;
    // Entered from a Bun timer, where your JavaScript is on the stack, through the raw layer.
    function enterNestedLoop(): void {
      const until = objc.NSDate.dateWithTimeIntervalSinceNow_(0.15);
      const t = performance.now();
      while (performance.now() - t < 150) {
        objc.NSRunLoop.currentRunLoop().runMode_beforeDate_(globalObject("NSEventTrackingRunLoopMode"), until);
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        MainLoop.after(5, () => ran++);
        enterNestedLoop();
        ranDuringCall = ran;
        // Again from the same call site, now from inside a turn: JavaScript on the stack too.
        MainLoop.post(() => {
          MainLoop.after(5, () => ran++);
          enterNestedLoop();
          resolve();
        });
      }, 0);
    });
    await until(() => ran === 2 && nestingReports.length >= reportsBefore + 2, 2000);
    console.warn = warn;
    const reports = nestingReports.slice(reportsBefore);
    check("run-to-completion: no turn ran while the JavaScript that entered the loop was mid-call", ranDuringCall === 0, ranDuringCall);
    check("run-to-completion: the turn ran after it returned", ran === 2, ran);
    check("run-to-completion: the nesting was recorded, with its mode", reports.length === 2 && reports.every((r) => r.mode === "NSEventTrackingRunLoopMode" && r.durationMs >= 140), reports);
    check("run-to-completion: reported with the call site", reports[0]?.site.includes("test/mainloop.ts") && reports[0]?.site === reports[1]?.site, reports[0]?.site);
    check("run-to-completion: reported once per call site", warnings.filter((w) => w.includes("nested run loop")).length === 1, warnings);
    check("run-to-completion: counted as started from JavaScript", MainLoop.stats.nested.fromJavaScript >= 2, MainLoop.stats.nested);
    check("and reported as a stall from JavaScript when it ran past the threshold", stalls.some((s) => s.origin === "javascript" && s.durationMs >= 140), stalls.filter((s) => s.origin === "javascript"));
  }

  // -------------------------------------------------------------------------
  // 6. Frames
  // -------------------------------------------------------------------------
  {
    // Pacing per screen: a view on each screen gets frames at that screen's rate.
    const screens = objc.NSScreen.screens();
    for (let i = 0; i < Number(screens.count()); i++) {
      const screen = screens.objectAtIndex_(i);
      const rate = Number(screen.maximumFramesPerSecond());
      const sf = screen.frame();
      const w = new Window({ title: `screen ${i}`, size: { width: 200, height: 120 }, show: true });
      w.native.setFrameOrigin_({ x: Number(sf.x) + 40, y: Number(sf.y) + 40 });
      await sleep(200);
      const view = new View(objc.NSView.alloc().init());
      w.content = view;
      await sleep(100);
      let n = 0;
      let first = 0;
      let last = 0;
      const stop = onViewFrame(view, (f) => {
        if (n++ === 0) first = f.timestamp;
        last = f.timestamp;
      }, `screen ${i}`);
      await sleep(1000);
      stop();
      const measured = (n - 1) / (last - first);
      console.log(`  (screen ${i}: ${measured.toFixed(1)} frames a second, at ${rate} Hz)`);
      check(`frames: a view on screen ${i} gets frames at its rate (${rate} Hz)`, Math.abs(measured - rate) <= rate * 0.1, measured);
      w.close();
    }
  }
  if (gpuAvailable()) {
    // Live resize without stretched frames: a GPUView in a window being resized.
    const gw = new Window({ title: "gpu resize", size: { width: 360, height: 260 }, show: true });
    const view = new GPUView({ onFrame: () => {} });
    gw.content = view;
    await sleep(300);
    const gwn = Number(gw.native.windowNumber());
    const width = Number(gw.native.frame().width);
    const post = (type: number, x: number, y: number) =>
      app.postEvent_atStart_(objc.NSEvent.mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
        type, { x, y }, 0, objc.NSProcessInfo.processInfo().systemUptime(), gwn, null, 0, 1, 1), false);
    post(1, width - 2, 2);
    await new Promise<void>((resolve) => {
      let step = 0;
      const t = MainLoop.every(16, () => {
        step++;
        if (step <= 30) post(6, width - 2 + step * 4, 2 - step * 3);
        else {
          post(2, width - 2 + 120, 2 - 90);
          t.dispose();
          resolve();
        }
      });
    });
    await sleep(100);
    const s = view.stats.liveResize;
    console.log(`  (GPUView live resize: ${s.frames} frames for ${s.sizeChanges} size changes, ${s.mismatched} mismatched)`);
    check("frames: a GPUView draws through a live resize, presenting with the window's transaction", s.frames >= 10 && s.sizeChanges >= 10, s);
    check("frames: and no frame is the wrong size for the window (no stretched frames)", s.mismatched === 0, s);
    view.dispose();
    gw.close();
  }
}

// Idle: nothing animates — no frame clock runs, no main-loop turn wakes the thread — and the CPU it
// takes is v1's (1.7% measured on an M2 Pro, macOS 26.6, before this branch).
async function idle(): Promise<void> {
  thread.channel.send({ cmd: "stop-tick" });
  await thread.terminate();
  timerHandle.dispose();
  stopFrames();
  await sleep(1500);
  const turns0 = MainLoop.stats.turns.count;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  // Bun's own timer here: a main-loop one would be a wakeup.
  await new Promise((r) => setTimeout(r, 3000));
  const wall = (performance.now() - t0) / 1000;
  const c = process.cpuUsage(cpu0);
  const pct = ((c.user + c.system) / 1e6 / wall) * 100;
  const turns = MainLoop.stats.turns.count - turns0;
  console.log(`  (idle: ${pct.toFixed(2)}% CPU over ${wall.toFixed(1)} s, ${turns} main-loop turns, clocks ${JSON.stringify(MainLoop.stats.frames.clocks.map((c) => c.running))})`);
  check("idle: no frame clock runs while nothing animates", MainLoop.stats.frames.clocks.every((c) => !c.running));
  check("idle: no main-loop turn wakes an idle app", turns === 0, turns);
  check(`idle: CPU is v1's (under ${CI ? 12 : 3}%)`, pct < (CI ? 12 : 3), pct);
}

setTimeout(async () => {
  try {
    await main();
    await idle();
  } catch (e) {
    failures++;
    console.log("  FAIL the test threw:", e);
  }
  quit();
}, 0);

await run({ quitAfterLastWindow: false });
console.log(failures === 0 ? "\nALL MAIN LOOP TESTS PASSED" : `\n${failures} MAIN LOOP FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
