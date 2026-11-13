// Threads (src/thread.ts, docs/main-loop/spec.md §7 and §11 tests 4 and 5): the channel keeps
// order both ways and coalesces its wake-ups; each backpressure mode does what it says; a thread
// that ends with messages in flight still delivers them; a message larger than the ring goes
// through the arena, intact; a shared cell is never read torn, however hard it is written; an
// uncaught error reaches the main thread with its stack; and a thread that will not stop is
// abandoned at the deadline, never waited for forever.
//
// The main thread receives in main-loop turns, so the waiting here pumps.

import { initApp, pumpOnce, quit, run } from "../src/runtime.ts";
import { spawnThread, type Thread } from "../src/thread.ts";
import { Hammer, Setting } from "./fixtures/thread-layouts.ts";

let failures = 0;
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

initApp();

const WORKER = new URL("./fixtures/thread-worker.ts", import.meta.url);

/** Pump until `cond` holds or `ms` pass. */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) return false;
    pumpOnce(0.002);
    await Bun.sleep(0);
  }
  return true;
}

/** A thread and everything it has sent, once it has said it is ready. */
async function start(options: Parameters<typeof spawnThread>[1] = {}): Promise<{ thread: Thread; got: any[] }> {
  const thread = spawnThread(WORKER, options);
  const got: any[] = [];
  thread.channel.onMessage((m) => got.push(m));
  await until(() => got.some((m) => m?.ready), 10_000);
  got.length = 0;
  return { thread, got };
}

function pattern(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 255;
  }
  return out;
}

function inOrder(seqs: number[]): boolean {
  for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1]! + 1) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Order, both ways, and coalesced wake-ups
// ---------------------------------------------------------------------------
{
  // Sent before the thread has started, let alone listened: kept for its first handler.
  const early = spawnThread(WORKER, { name: "early" });
  const got: any[] = [];
  early.channel.send({ cmd: "ping", n: 7 });
  await Bun.sleep(100);
  early.channel.onMessage((m) => got.push(m));
  await until(() => got.some((m) => m?.pong === 7), 5000);
  check("a message sent before the thread listens is kept for it, and one it sent before we listened for us", got.some((m) => m?.pong === 7) && got.some((m) => m?.ready), got);
  await early.terminate();
}
{
  const { thread, got } = await start({ name: "order" });
  check("a thread starts and says so", thread.name === "order");
  const N = 20_000;
  thread.channel.send({ cmd: "burst", n: N });
  await until(() => got.some((m) => m?.burstDone !== undefined), 20_000);
  const seqs = got.filter((m) => m?.seq !== undefined).map((m) => m.seq);
  check(`${N} messages from a thread arrive, all of them`, seqs.length === N, seqs.length);
  check("in the order they were sent", inOrder(seqs) && seqs[0] === 0);
  const stats = thread.channel.stats;
  console.log(`  (${N} messages woke the main thread ${stats.wakeups} times)`);
  check("wake-ups coalesce: far fewer than one a message", stats.wakeups > 0 && stats.wakeups < N / 20, stats);

  got.length = 0;
  const M = 5_000;
  for (let i = 0; i < M; i++) thread.channel.send({ cmd: "echo", value: i });
  await until(() => got.length >= M, 20_000);
  check(`${M} messages to a thread arrive in order, and come back in order`, got.length === M && inOrder(got), got.length);

  // Strings, typed arrays and plain values each keep what they are.
  got.length = 0;
  const values = ["text ✓", new Float32Array([1.5, -2, 3]), new Uint8Array([1, 2, 3]), { a: [1, { b: "c" }], d: new Date(0), m: new Map([[1, 2]]) }];
  for (const value of values) thread.channel.send({ cmd: "echo", value });
  await until(() => got.length >= values.length, 5000);
  check("a string round-trips", got[0] === "text ✓", got[0]);
  check("a Float32Array round-trips as one", got[1] instanceof Float32Array && got[1][0] === 1.5 && got[1][2] === 3, got[1]);
  check("a Uint8Array round-trips as one", got[2] instanceof Uint8Array && got[2].join() === "1,2,3", got[2]);
  check("a structured-clone value round-trips", got[3]?.a?.[1]?.b === "c" && got[3]?.d instanceof Date && got[3]?.m?.get(1) === 2, got[3]);
  await thread.terminate();
}

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------
// A small ring, and a main thread that is not pumping while the thread sends: nothing drains it.
for (const mode of ["fail", "drop-oldest"] as const) {
  const { thread, got } = await start({ name: mode, backpressure: mode, ringBytes: 4096 });
  const N = 1000;
  thread.channel.send({ cmd: "burst", n: N });
  await Bun.sleep(300); // the thread sends into a ring no one is reading
  await until(() => thread.channel.stats.peerSent + thread.channel.stats.peerDropped >= N, 5000);
  await until(() => !thread.channel.pending, 5000);
  const seqs = got.filter((m) => m?.seq !== undefined).map((m) => m.seq);
  const stats = thread.channel.stats;
  if (mode === "fail") {
    check(`"fail": a full ring refuses what does not fit (${seqs.length} of ${N} kept)`, seqs.length > 0 && seqs.length < N && stats.peerDropped > 0, stats);
    check(`"fail": what was kept is the oldest, in order`, seqs[0] === 0 && inOrder(seqs), seqs.slice(0, 5));
  } else {
    check(`"drop-oldest": the oldest make room (${seqs.length} of ${N} kept)`, seqs.length > 0 && seqs.length < N && stats.peerDropped > 0, stats);
    check(`"drop-oldest": what was kept is the latest, in order`, seqs.at(-1) === N - 1 && inOrder(seqs), seqs.slice(-5));
  }
  await thread.terminate();
}
{
  // "wait": the thread waits for room while the main thread drains, and nothing is lost.
  const { thread, got } = await start({ name: "wait", backpressure: "wait", ringBytes: 4096 });
  const N = 5000;
  thread.channel.send({ cmd: "burst", n: N });
  await until(() => got.some((m) => m?.burstDone !== undefined), 20_000);
  const seqs = got.filter((m) => m?.seq !== undefined).map((m) => m.seq);
  check(`"wait": a thread waits for room in a small ring, and all ${N} arrive in order`, seqs.length === N && inOrder(seqs), seqs.length);
  check(`"wait": nothing was dropped`, thread.channel.stats.peerDropped === 0, thread.channel.stats);
  await thread.terminate();
}
{
  // The main thread never waits: "wait" is "fail" there.
  const { thread } = await start({ name: "main-wait", backpressure: "wait", ringBytes: 4096 });
  let refused = 0;
  for (let i = 0; i < 5000; i++) if (!thread.channel.send({ cmd: "noop", pad: "x".repeat(64) })) refused++;
  check(`a full ring refuses the main thread's send instead of blocking it (${refused} refused)`, refused > 0);
  await thread.terminate();
}

// ---------------------------------------------------------------------------
// Ending with messages in flight
// ---------------------------------------------------------------------------
{
  const { thread, got } = await start({ name: "exiting" });
  let exitCode: number | undefined;
  thread.onExit((code) => (exitCode = code));
  thread.channel.send({ cmd: "burst-exit", n: 500 });
  await until(() => exitCode !== undefined, 5000);
  await until(() => got.filter((m) => m?.seq !== undefined).length >= 500, 2000);
  const seqs = got.filter((m) => m?.seq !== undefined).map((m) => m.seq);
  check("a thread that exits straight after sending: all 500 still arrive, in order", seqs.length === 500 && inOrder(seqs), seqs.length);
  check("and its exit is seen, with its code", exitCode === 0 && thread.exited, exitCode);
}

// ---------------------------------------------------------------------------
// Messages larger than the ring: through the arena
// ---------------------------------------------------------------------------
{
  const { thread, got } = await start({ name: "arena", ringBytes: 4096, arenaBytes: 64 * 1024 });
  for (const [bytes, seed] of [[1 << 20, 3], [8 << 20, 4]] as const) {
    got.length = 0;
    thread.channel.send({ cmd: "big", bytes, seed });
    await until(() => got.some((m) => m instanceof Uint8Array), 10_000);
    const back = got.find((m) => m instanceof Uint8Array) as Uint8Array | undefined;
    const want = pattern(bytes, seed);
    let same = back?.length === want.length;
    for (let i = 0; same && i < want.length; i++) same = back![i] === want[i];
    check(`a ${bytes >> 20} MiB message from a thread, through a 4 KiB ring and a growing arena, arrives intact`, same, back?.length);

    got.length = 0;
    thread.channel.send({ cmd: "check-big", bytes, seed });
    const sent = thread.channel.send(want);
    await until(() => got.some((m) => m?.bigIntact !== undefined), 10_000);
    const verdict = got.find((m) => m?.bigIntact !== undefined);
    check(`and a ${bytes >> 20} MiB message to it`, sent && verdict?.bigIntact === true, verdict);
  }
  await thread.terminate();
}

// ---------------------------------------------------------------------------
// Shared cells (§7.4)
// ---------------------------------------------------------------------------
{
  const { thread, got } = await start({ name: "cells" });
  const hammer = thread.cell(Hammer, "read");
  await Bun.sleep(50); // its memory reaches the thread
  thread.channel.send({ cmd: "hammer", ms: 1000 });
  // Read as fast as possible for as long as the thread writes: never two fields that differ.
  const out = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0 };
  let reads = 0;
  let torn = 0;
  let changed = 0;
  let last = -1;
  const end = performance.now() + 1100;
  while (performance.now() < end) {
    hammer.readInto(out);
    reads++;
    if (out.a !== out.b || out.a !== out.c || out.a !== out.d || out.a !== out.e || out.a !== out.f || out.a !== out.g || out.a !== out.h) torn++;
    if (out.a !== last) {
      changed++;
      last = out.a;
    }
  }
  await until(() => got.some((m) => m?.hammered !== undefined), 5000);
  const writes = got.find((m) => m?.hammered !== undefined)?.hammered;
  console.log(`  (${reads} reads of an eight-word cell during ${writes} writes; ${changed} distinct values seen)`);
  check("a cell is never read torn while a thread hammers it", torn === 0 && reads > 100_000 && changed > 1000, { torn, reads, changed });
  check("its version counts the writes", hammer.version >= writes, { version: hammer.version, writes });

  // The other way: the main thread writes, the thread reads.
  const setting = thread.cell(Setting, "write");
  setting.write({ level: 0.75, on: true });
  await Bun.sleep(50);
  got.length = 0;
  thread.channel.send({ cmd: "read-setting" });
  await until(() => got.some((m) => m?.setting), 5000);
  const seen = got.find((m) => m?.setting)?.setting;
  check("a cell the main thread writes is read by the thread, booleans as booleans", seen?.level === 0.75 && seen?.on === true, seen);
  let threw = false;
  try {
    thread.cell(Setting, "read");
  } catch {
    threw = true;
  }
  check("a cell has one writer: the same side cannot also read it as the other end", threw);
  await thread.terminate();
}

// ---------------------------------------------------------------------------
// Errors and ending
// ---------------------------------------------------------------------------
{
  const { thread } = await start({ name: "thrower" });
  let error: any;
  let exitCode: number | undefined;
  thread.onError((e) => (error = e));
  thread.onExit((code) => (exitCode = code));
  thread.channel.send({ cmd: "throw" });
  await until(() => error !== undefined && exitCode !== undefined, 5000);
  check("an uncaught error in a thread reaches the main thread through its channel", error?.message === "thrown in the thread on purpose" && error?.thread === "thrower", error);
  check("with its stack, naming the thread's file", String(error?.stack).includes("thread-worker.ts"), error?.stack);
  check("and the thread ends, and is not restarted", exitCode === 1 && thread.exited, exitCode);
}
{
  const { thread, got } = await start({ name: "polite" });
  const t0 = performance.now();
  const closing = thread.terminate(2000);
  await until(() => thread.exited, 3000);
  await closing;
  check("terminate() runs the thread's onClose handlers, and it exits", got.some((m) => m?.closing) && thread.exitCode === 0, { got, code: thread.exitCode });
  check("promptly", performance.now() - t0 < 1000, performance.now() - t0);
}
{
  const { thread, got } = await start({ name: "stuck" });
  thread.channel.send({ cmd: "stuck" });
  await until(() => got.some((m) => m?.stuck), 5000);
  const t0 = performance.now();
  await thread.terminate(300);
  const ms = performance.now() - t0;
  check(`a thread that will not stop is ended at the deadline, not waited for (${ms.toFixed(0)} ms)`, ms >= 290 && ms < 1500, ms);
}

// ---------------------------------------------------------------------------
// Quitting ends every thread, after the quit handlers
// ---------------------------------------------------------------------------
{
  const { thread } = await start({ name: "on quit" });
  setTimeout(() => quit(), 200);
  const t0 = performance.now();
  await run({ quitAfterLastWindow: false });
  check("run() ends live threads when it returns", thread.exited, thread.exitCode);
  check("within its deadline", performance.now() - t0 < 2000, performance.now() - t0);
}

console.log(failures === 0 ? "\nALL THREAD TESTS PASSED" : `\n${failures} THREAD FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
