// Can a worker get work onto the main thread while AppKit is in a nested loop? Bun's postMessage
// is delivered by the main thread's event loop, which is stopped; GCD's main queue is served by
// the run loop itself.
import { JSCallback, FFIType } from "bun:ffi";
import { initApp } from "../../../src/runtime.ts";
import { objc } from "../../../src/objc.ts";
initApp();
let delivered = 0;
let onMain = 0;
const isMain = () => Boolean(objc.NSThread.isMainThread());
const callback = new JSCallback(() => {
  delivered++;
  if (isMain()) onMain++;
}, { args: [FFIType.ptr], returns: FFIType.void });
const counts = new Int32Array(new SharedArrayBuffer(4));
const worker = new Worker(new URL("./poster.ts", import.meta.url).href);
let messages = 0;
worker.onmessage = () => messages++;
worker.postMessage({ fn: Number(callback.ptr), counts: counts.buffer });
await Bun.sleep(300);
const before = { delivered, posted: Atomics.load(counts, 0) };
const t0 = performance.now();
const until = objc.NSDate.dateWithTimeIntervalSinceNow_(1.0);
while (performance.now() - t0 < 1000) objc.NSRunLoop.currentRunLoop().runMode_beforeDate_("NSEventTrackingRunLoopMode", until);
console.log(JSON.stringify({
  postedByWorker: Atomics.load(counts, 0) - before.posted,
  deliveredOnMainDuringNestedLoop: delivered - before.delivered,
  allOnTheMainThread: onMain === delivered,
}));
worker.terminate();
process.exit(0);
