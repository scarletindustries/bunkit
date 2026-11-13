// For threads-ffi.ts: a thread that keeps native code busy calling into it, and is ended at any
// moment. bun:ffi into BunKit's own library (signalling the main loop), a JSCallback that native
// code calls on this thread (libc's qsort, with a JavaScript comparator), JSCallbacks made and
// closed, and messages to the main thread — all in a loop that never waits for anything.
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";
import { parent } from "../../../src/thread.ts";
import { workerData } from "node:worker_threads";

const bunkit = dlopen((workerData as any).bunkit.lib, { br_main_signal: { args: [], returns: FFIType.void } }).symbols;
const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  qsort: { args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.void },
}).symbols;

const values = new Int32Array(64);
const view = new DataView(values.buffer);
const base = Number(ptr(values));
let compares = 0;
const comparator = new JSCallback(
  (a: number, b: number) => {
    compares++;
    return view.getInt32(a - base, true) - view.getInt32(b - base, true);
  },
  { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
);

let rounds = 0;
async function loop(): Promise<void> {
  for (;;) {
    for (let i = 0; i < values.length; i++) values[i] = (Math.random() * 1e6) | 0;
    libc.qsort(ptr(values), values.length, 4, comparator.ptr);
    bunkit.br_main_signal();
    // A short-lived callback, made and closed while others are in use.
    const temp = new JSCallback(() => 0, { args: [], returns: FFIType.i32 });
    temp.close();
    if (++rounds % 64 === 0) {
      parent?.channel.send({ rounds, compares });
      await Promise.resolve();
    }
    if (rounds % 1024 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}
void loop();
