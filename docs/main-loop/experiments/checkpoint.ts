// Open question 2: what makes a microtask checkpoint in Bun when Bun's own loop is not running.
//
// Queues the same mix of nextTicks, promise reactions and queueMicrotask, with each kind also
// queueing the other, first from a Bun timer (Bun's own order, the reference), then from a
// common-modes NSTimer inside a nested run loop, where Bun's loop is stopped, with each candidate
// checkpoint called before the callback returns. Prints what each ran, and in which order.
import { initApp } from "../../../src/runtime.ts";
import { objc, createDelegate } from "../../../src/objc.ts";
import { drainMicrotasks } from "bun:jsc";

initApp();

function queue(log: string[]): void {
  process.nextTick(() => {
    log.push("tick1");
    Promise.resolve().then(() => log.push("promise-from-tick"));
    process.nextTick(() => log.push("tick-from-tick"));
  });
  Promise.resolve().then(() => {
    log.push("promise1");
    process.nextTick(() => log.push("tick-from-promise"));
    queueMicrotask(() => log.push("micro-from-promise"));
  });
  queueMicrotask(() => log.push("micro1"));
  process.nextTick(() => log.push("tick2"));
}

// Each candidate runs `body` (the callback's own work) and then its checkpoint.
const candidates: Record<string, (body: () => void) => void> = {
  none: (body) => body(),
  tickCallback: (body) => {
    body();
    (process as any)._tickCallback();
  },
  drainMicrotasks: (body) => {
    body();
    drainMicrotasks();
  },
  tickCallbackThenDrain: (body) => {
    body();
    (process as any)._tickCallback();
    drainMicrotasks();
  },
  // The callback itself queued as a nextTick, then a drain: Bun's tick runner runs it, its ticks,
  // then the microtasks, as it does after one of its own tasks.
  bodyAsTickThenDrain: (body) => {
    process.nextTick(body);
    drainMicrotasks();
  },
};

// Reference: Bun's own order, from a Bun timer.
const reference: string[] = [];
setTimeout(() => queue(reference), 0);
await Bun.sleep(20);

const results: Record<string, string[]> = {};
let current: string | undefined;
const target = createDelegate(
  {
    "tick:": () => {
      if (!current || results[current]) return;
      const log: string[] = [];
      results[current] = log;
      candidates[current]!(() => queue(log));
      log.push("|returned"); // anything after this ran later, not in the checkpoint
    },
  },
  { types: { "tick:": "v@:@" }, name: "CheckpointTick" },
);
const timer = objc.NSTimer.timerWithTimeInterval_target_selector_userInfo_repeats_(0.005, target, "tick:", null, true);
objc.NSRunLoop.currentRunLoop().addTimer_forMode_(timer, "kCFRunLoopCommonModes");

for (const name of Object.keys(candidates)) {
  current = name;
  // -runMode:beforeDate: can return before the timer fires, so loop until it has.
  const t0 = performance.now();
  while (!results[name] && performance.now() - t0 < 1000) {
    const until = objc.NSDate.dateWithTimeIntervalSinceNow_(0.05);
    objc.NSRunLoop.currentRunLoop().runMode_beforeDate_("NSEventTrackingRunLoopMode", until);
  }
  current = undefined;
  await Bun.sleep(10); // let Bun run whatever was left, so it shows up after "|returned"
}
timer.invalidate();

console.log("bun's own order:      ", reference.join(" "));
for (const [name, log] of Object.entries(results)) {
  const ok = log.slice(0, reference.length).join(" ") === reference.join(" ") && log[reference.length] === "|returned";
  console.log(`${name.padEnd(22)}${ok ? "same" : "DIFF"}  ${log.join(" ")}`);
}
process.exit(0);
