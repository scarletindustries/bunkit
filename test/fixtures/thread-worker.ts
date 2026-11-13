// A thread for test/thread.ts and test/mainloop.ts, told what to do by messages from the main
// thread. Runs under bunkit/thread: `parent` is its end of the channel.

import { parent } from "../../src/thread.ts";
import { Hammer, Setting, Ticker } from "./thread-layouts.ts";

if (!parent) throw new Error("thread-worker.ts is started with spawnThread");
const channel = parent.channel;

/** `n` bytes that depend on `seed` and their position (the same as test/thread.ts makes). */
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

let ticking: ReturnType<typeof setInterval> | undefined;

channel.onMessage((m: any) => {
  switch (m?.cmd) {
    case "ping":
      channel.send({ pong: m.n });
      break;
    case "echo":
      channel.send(m.value);
      break;
    case "burst": {
      let sent = 0;
      for (let i = 0; i < m.n; i++) if (channel.send({ seq: i })) sent++;
      channel.send({ burstDone: sent, stats: channel.stats });
      break;
    }
    case "burst-exit":
      for (let i = 0; i < m.n; i++) channel.send({ seq: i });
      process.exit(0);
      break;
    case "big":
      channel.send(pattern(m.bytes, m.seed));
      break;
    case "check-big": {
      // A large message from the main thread: did it arrive intact?
      const want = pattern(m.bytes, m.seed);
      channel.send({ checking: true });
      pendingBig = want;
      break;
    }
    case "tick": {
      // Every `ms`, a message with a sequence number and how many times this thread's own timer
      // has fired, and the ticker cell updated: what test/mainloop.ts watches during nesting.
      const cell = parent!.cell(Ticker, "write");
      let seq = 0;
      let own = 0;
      if (ticking) clearInterval(ticking);
      ticking = setInterval(() => {
        own++;
        cell.write({ own, at: performance.now() });
        channel.send({ tick: seq++, own });
      }, m.ms);
      break;
    }
    case "stop-tick":
      if (ticking) clearInterval(ticking);
      ticking = undefined;
      channel.send({ stopped: true });
      break;
    case "hammer": {
      // Write a multi-word value as fast as possible: every field the same number.
      const cell = parent!.cell(Hammer, "write");
      const until = performance.now() + m.ms;
      let i = 0;
      while (performance.now() < until) {
        i++;
        cell.write({ a: i, b: i, c: i, d: i, e: i, f: i, g: i, h: i });
      }
      channel.send({ hammered: i });
      break;
    }
    case "read-setting":
      channel.send({ setting: parent!.cell(Setting, "read").read() });
      break;
    case "throw":
      setTimeout(() => {
        throw new Error("thrown in the thread on purpose");
      }, 0);
      break;
    case "stuck": {
      // Never yields, so never hears the main thread ask it to close.
      channel.send({ stuck: true });
      for (;;) {
        // spin
      }
    }
  }
  if (pendingBig && m instanceof Uint8Array) {
    const want = pendingBig;
    pendingBig = undefined;
    let same = m.length === want.length;
    for (let i = 0; same && i < want.length; i++) same = m[i] === want[i];
    channel.send({ bigIntact: same, length: m.length });
  }
});

let pendingBig: Uint8Array | undefined;

parent.onClose(() => {
  channel.send({ closing: true });
});

channel.send({ ready: parent.name });
