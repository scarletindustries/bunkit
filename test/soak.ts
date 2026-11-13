// Soak test — churn objects, delegates, windows and events for a while and
// check that neither the JS wrapper table nor RSS grows without bound.
//
//   bun run test/soak.ts            # ~20s
//   SOAK_SECONDS=120 bun run test/soak.ts
//
// Run it under zombies to catch over-releases at the same time:
//   NSZombieEnabled=YES MallocScribble=1 bun run test/soak.ts

import { createBlock, createDelegate, objc, sendFromPump, stats, toJS } from "../src/objc.ts";
import { initApp, MainLoop, onFrame, pumpOnce } from "../src/runtime.ts";
import { mainLoopInternals } from "../src/mainloop.ts";
import { liveThreads, spawnThread, type Thread } from "../src/thread.ts";
import { Button, Label, Table, VStack, Window } from "../src/ui/index.ts";

const SECONDS = Number(process.env.SOAK_SECONDS ?? 20);
let failures = 0;
function check(name: string, cond: any, extra?: any) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const rssMB = () => Math.round(process.memoryUsage.rss() / (1024 * 1024));

initApp();

// A long-lived window so AppKit has real work to do throughout.
let clicks = 0;
const button = new Button({ title: "soak", onClick: () => clicks++ });
interface SoakRow { a: string; b: number }
const table = new Table<SoakRow>({
  columns: [{ id: "a", title: "A" }, { id: "b", title: "B", width: 80 }],
  rows: [],
  grow: 1,
});
const win = new Window({
  title: "soak",
  size: { width: 420, height: 320 },
  content: new VStack({ spacing: 8, padding: 12 }, [button, table]),
  show: true,
});
for (let i = 0; i < 30; i++) pumpOnce(0.004);

// The main loop's side (docs/main-loop/spec.md §11, test 7): a thread streaming messages for the
// whole soak, its cell read, and every round timers, tasks, frames, trampolined calls and
// messages to it — and every so often a thread started and ended, its rings with it. Sources,
// timers, rings and callbacks must all be let go.
const WORKER = new URL("./fixtures/thread-worker.ts", import.meta.url);
const streamer = spawnThread(WORKER, { name: "streamer" });
let streamed = 0;
let echoed = 0;
streamer.channel.onMessage((m: any) => {
  if (m?.tick !== undefined) streamed++;
  else if (m?.pong !== undefined) echoed++;
});
streamer.channel.send({ cmd: "tick", ms: 2 });
let timersRun = 0;
let tasksRun = 0;
let framesSeen = 0;
let trampolined = 0;
let shortLived = 0;
for (let i = 0; i < 30; i++) pumpOnce(0.004);

// Settle before the baseline: first-render allocations are not a leak.
Bun.gc(true);
await Bun.sleep(50);
Bun.gc(true);

const base = { ...stats(), rss: rssMB() };
console.log(`  baseline: ${base.live} live wrappers, ${base.rss} MB RSS`);

const t0 = performance.now();
let rounds = 0;
const samples: Array<{ t: number; live: number; rss: number }> = [];

while ((performance.now() - t0) / 1000 < SECONDS) {
  // 1. Strings, numbers and containers — the ordinary marshalling churn.
  for (let i = 0; i < 400; i++) {
    const s = objc.NSString.stringWithUTF8String_(`row ${rounds}-${i}`);
    s.uppercaseString();
    objc.NSNumber.numberWithDouble_(i * 1.5).doubleValue();
  }
  const arr = objc.NSMutableArray.array();
  for (let i = 0; i < 50; i++) arr.addObject_({ k: `v${i}`, n: i });
  toJS(arr);

  // 2. Target/action and delegate round trips.
  for (let i = 0; i < 200; i++) button.native.target().brAction_(button.native);

  // 3. Table reloads — exercises the datasource callbacks and cell reuse.
  table.rows = Array.from({ length: 40 }, (_, i) => ({ a: `a${rounds}-${i}`, b: i }));
  for (let i = 0; i < 3; i++) pumpOnce(0.002);

  // 4. Short-lived delegates and blocks. Delegate *classes* are cached by
  //    shape, so this must not create a new Obj-C class each time.
  const d = createDelegate({ windowDidResize_: () => {} }, { protocols: ["NSWindowDelegate"] });
  d.respondsTo("windowDidResize:");
  const b = createBlock("v@?q", () => {});
  b.dispose();

  // 5. Windows come and go.
  if (rounds % 20 === 0) {
    const w = new Window({ title: `w${rounds}`, size: { width: 200, height: 140 }, show: false });
    w.content = new VStack({ padding: 8 }, [new Label({ text: "hi" })]);
    for (let i = 0; i < 2; i++) pumpOnce(0.002);
    w.close();
  }

  // 6. The main loop: timers made and dropped, tasks, frames, trampolined calls, and messages.
  for (let i = 0; i < 20; i++) {
    const t = MainLoop.after(i % 3, () => void timersRun++);
    if (i % 2) t.dispose();
  }
  const every = MainLoop.every(1, () => void timersRun++);
  for (let i = 0; i < 50; i++) MainLoop.post(() => void tasksRun++);
  const stopFrames = onFrame(() => void framesSeen++);
  if (rounds % 10 === 0) void MainLoop.nextFrame().then(() => void framesSeen++);
  void sendFromPump(objc.NSString.stringWithUTF8String_(`soak ${rounds}`), "length").then(() => void trampolined++);
  for (let i = 0; i < 5; i++) streamer.channel.send({ cmd: "ping", n: i });
  for (let i = 0; i < 3; i++) pumpOnce(0.002);
  every.dispose();
  stopFrames();
  if (rounds % 50 === 0) {
    const t: Thread = spawnThread(WORKER, { name: `short ${rounds}`, ringBytes: 64 * 1024 });
    let pong = false;
    t.channel.onMessage((m: any) => {
      if (m?.pong !== undefined) pong = true;
    });
    t.channel.send({ cmd: "ping", n: 1 });
    const until = performance.now() + 2000;
    while (!pong && performance.now() < until) {
      pumpOnce(0.002);
      await Bun.sleep(0);
    }
    await t.terminate();
    if (pong) shortLived++;
  }

  rounds++;
  if (rounds % 25 === 0) {
    Bun.gc(true);
    await Bun.sleep(10);
    samples.push({ t: (performance.now() - t0) / 1000, live: stats().live, rss: rssMB() });
  }
  await Bun.sleep(0);
}

Bun.gc(true);
await Bun.sleep(100);
Bun.gc(true);
const end = { ...stats(), rss: rssMB() };

console.log(`\n  ${rounds} rounds in ${SECONDS}s`);
console.log(`  wrappers created: ${end.wrappersCreated}, live now: ${end.live} (was ${base.live})`);
console.log(`  msgSend calls:    ${end.calls}`);
console.log(`  Obj-C classes:    ${end.classes} (shape-cached)`);
console.log(`  RSS:              ${base.rss} MB -> ${end.rss} MB`);
console.log(`  samples: ${samples.map((s) => `${s.t.toFixed(0)}s:${s.live}w/${s.rss}MB`).join("  ")}`);

check("did real work", end.calls > 100000, end.calls);

// The main loop let go of everything it was given.
for (let i = 0; i < 50; i++) pumpOnce(0.004);
const internals = mainLoopInternals();
console.log(`  main loop:        ${timersRun} timers, ${tasksRun} tasks, ${framesSeen} frames, ${trampolined} trampolined calls`);
console.log(`  thread:           ${streamed} messages streamed in, ${echoed} pings answered; ${shortLived} short-lived threads`);
console.log(`  held now:         ${JSON.stringify(internals)}`);
check("main-loop timers, tasks, frames and trampolined calls all ran",
  timersRun > rounds && tasksRun === rounds * 50 && framesSeen > 0 && trampolined >= rounds - 2,
  { timersRun, tasksRun, framesSeen, trampolined, rounds });
check("no timer, task, frame subscriber or trampolined call is left behind",
  internals.liveTimers === 0 && internals.tasks === 0 && internals.subscribers === 0 && internals.waiting === 0,
  internals);
check("cancelled timers are dropped, not kept", internals.timers < 64, internals.timers);
check("the thread streamed throughout and answered every ping", streamed > SECONDS * 300 && echoed === rounds * 5, { streamed, echoed });
check("every short-lived thread started, answered and ended", shortLived === Math.ceil(rounds / 50) && liveThreads().length === 1, { shortLived, live: liveThreads().length });
await streamer.terminate();
check("all target/action calls landed", clicks === rounds * 200, `${clicks} vs ${rounds * 200}`);

// The wrapper table is the thing that would grow without bound if the
// FinalizationRegistry were not firing.
check(
  "live wrapper count stayed bounded",
  end.live < base.live + 400,
  `${base.live} -> ${end.live}`,
);

// Delegate classes are cached by shape: one per distinct selector set, not one
// per instance. Registered Obj-C classes can never be freed, so this matters.
check("delegate classes did not multiply", end.classes <= 12, end.classes);

// Some growth is expected (JIT, AppKit caches); unbounded growth is not.
// Under NSZombieEnabled nothing is ever freed — that is what a zombie is — so
// the memory assertions are meaningless there. The run is still worth doing:
// it is checking for over-releases, which show up as "message sent to
// deallocated instance" rather than as memory numbers.
const zombies = process.env.NSZombieEnabled === "YES";
const growth = end.rss - base.rss;
if (zombies) {
  console.log(`  (NSZombieEnabled: skipping memory assertions; ${growth} MB retained by design)`);
} else {
  check("RSS growth bounded", growth < 260, `${growth} MB over ${rounds} rounds`);
}

// Growth should flatten rather than track round count linearly.
if (samples.length >= 4 && !zombies) {
  const firstHalf = samples[Math.floor(samples.length / 2) - 1]!;
  const last = samples[samples.length - 1]!;
  const early = firstHalf.rss - base.rss;
  const late = last.rss - firstHalf.rss;
  console.log(`  first half: +${early} MB, second half: +${late} MB`);
  check("growth is flattening, not linear", late <= Math.max(early, 12) + 8, `${early} then ${late}`);
}

win.close();
console.log(failures === 0 ? "\nSOAK PASSED" : `\n${failures} SOAK FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
