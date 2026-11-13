// Open question 4: bun:ffi and JSCallback in threads under load. Four threads at a time, each
// calling into native code that calls back into it as fast as it can (ffi-worker.ts), each ended
// at a random moment 5–200 ms after it started — with calls in flight — and replaced, for
// SECONDS (default 60; the hour's soak is SECONDS=3600), while the main thread pumps, runs
// main-loop timers and receives every thread's messages. Prints what it saw, and the main
// thread's memory over time.
//
//   bun threads-ffi.ts            # a minute
//   SECONDS=3600 bun threads-ffi.ts
import { initApp, MainLoop, pumpOnce } from "../../../src/runtime.ts";
import { spawnThread, type Thread } from "../../../src/thread.ts";

initApp();
const SECONDS = Number(process.env.SECONDS ?? 60);
const WORKER = new URL("./ffi-worker.ts", import.meta.url);
const rss = () => Math.round(process.memoryUsage.rss() / (1024 * 1024));

let started = 0;
let ended = 0;
let messages = 0;
let compares = 0;
let errors = 0;
let ticks = 0;
MainLoop.every(10, () => ticks++);
const live = new Set<Thread>();

function startOne(): void {
  const t = spawnThread(WORKER, { name: `ffi ${started}`, ringBytes: 64 * 1024 });
  started++;
  live.add(t);
  t.channel.onMessage((m: any) => {
    messages++;
    compares = Math.max(compares, m.compares ?? 0);
  });
  t.onError((e) => {
    errors++;
    console.log(`  thread error: ${e.message}`);
  });
  // Ended mid-call: terminate() asks, and a thread busy in its loop is terminated at the deadline.
  setTimeout(async () => {
    await t.terminate(5);
    live.delete(t);
    ended++;
    startOne();
  }, 5 + Math.random() * 195);
}

for (let i = 0; i < 4; i++) startOne();
const t0 = performance.now();
const samples: string[] = [];
let nextSample = 0;
while ((performance.now() - t0) / 1000 < SECONDS) {
  pumpOnce(0.002);
  await Bun.sleep(0);
  const s = (performance.now() - t0) / 1000;
  if (s >= nextSample) {
    samples.push(`${s.toFixed(0)}s:${rss()}MB/${ended}`);
    nextSample += Math.max(5, SECONDS / 12);
  }
}
const seconds = (performance.now() - t0) / 1000;
console.log(JSON.stringify({
  seconds: Math.round(seconds),
  threadsStarted: started,
  threadsEndedMidCall: ended,
  messagesFromThreads: messages,
  errors,
  mainLoopTimerTicksPerSecond: Math.round(ticks / seconds),
  rssMB: samples,
}));
process.exit(0);
