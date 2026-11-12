// Counts its own setInterval ticks into shared memory, so the main thread can see whether a
// worker's event loop runs while the main thread is stuck in a nested AppKit loop.
declare const self: Worker;
self.onmessage = (event: MessageEvent<SharedArrayBuffer>) => {
  const counts = new Int32Array(event.data);
  setInterval(() => Atomics.add(counts, 0, 1), 10);
};
