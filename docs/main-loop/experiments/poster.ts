// Every 10 ms, put the main thread's callback on GCD's main queue — from this thread.
import { dlopen, FFIType } from "bun:ffi";
declare const self: Worker;
const sys = dlopen("/usr/lib/libSystem.B.dylib", {
  dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  dlsym: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
  dispatch_async_f: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
});
self.onmessage = (event: MessageEvent<{ fn: number; counts: SharedArrayBuffer }>) => {
  const handle = sys.symbols.dlopen(null, 2);
  const mainQueue = sys.symbols.dlsym(handle, Buffer.from("_dispatch_main_q\0"));
  const posted = new Int32Array(event.data.counts);
  setInterval(() => {
    sys.symbols.dispatch_async_f(mainQueue, null, event.data.fn);
    Atomics.add(posted, 0, 1);
  }, 10);
};
