// What runs while AppKit is in a nested loop entered from JavaScript — the shape of menu tracking:
// JS -> native -> a run loop in NSEventTrackingRunLoopMode, for one second.
import { initApp } from "../../../src/runtime.ts";
import { objc, createDelegate } from "../../../src/objc.ts";
import { drainMicrotasks } from "bun:jsc";

initApp();
const drain = process.argv[2] === "drain";

const counts = new Int32Array(new SharedArrayBuffer(4));
const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
worker.postMessage(counts.buffer);

let native = 0;          // calls from an NSTimer in common modes
let bun = 0;             // Bun setInterval ticks
let promisesRan = 0;     // promise continuations queued by the native callback
let promiseLate = 0;     // callbacks that found the previous one's continuation still waiting
let timeoutsQueued = 0, timeoutsRan = 0;
const target = createDelegate(
  {
    "tick:": () => {
      if (native > 0 && promisesRan < native) promiseLate++;
      native++;
      Promise.resolve().then(() => promisesRan++);
      if (native % 10 === 0) {
        timeoutsQueued++;
        setTimeout(() => timeoutsRan++, 0);
      }
      if (drain) drainMicrotasks();
    },
  },
  { types: { "tick:": "v@:@" }, name: "NestedTick" },
);
const timer = objc.NSTimer.timerWithTimeInterval_target_selector_userInfo_repeats_(0.01, target, "tick:", null, true);
objc.NSRunLoop.currentRunLoop().addTimer_forMode_(timer, "kCFRunLoopCommonModes");
setInterval(() => bun++, 10);

await Bun.sleep(300);
const before = { native, bun, worker: Atomics.load(counts, 0), promisesRan, timeoutsRan };
const t0 = performance.now();
// The nested loop: AppKit's event-tracking mode, entered from a JS call, for a second.
const until = objc.NSDate.dateWithTimeIntervalSinceNow_(1.0);
while (performance.now() - t0 < 1000) {
  objc.NSRunLoop.currentRunLoop().runMode_beforeDate_("NSEventTrackingRunLoopMode", until);
}
const inside = {
  ms: Math.round(performance.now() - t0),
  nativeCallbacks: native - before.native,
  bunIntervalTicks: bun - before.bun,
  workerTicks: Atomics.load(counts, 0) - before.worker,
  promiseContinuationsRan: promisesRan - before.promisesRan,
  callbacksThatFoundAContinuationStillWaiting: promiseLate,
  setTimeoutsQueuedInside: timeoutsQueued,
  setTimeoutsRanInside: timeoutsRan - before.timeoutsRan,
};
console.log(drain ? "with drainMicrotasks() in the callback" : "plain", JSON.stringify(inside, null, 1));
timer.invalidate();
worker.terminate();
process.exit(0);
