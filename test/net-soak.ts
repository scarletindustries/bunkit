// Soak test for src/net: open and close thousands of listeners and connections, and check that
// neither the native objects, the JavaScript side's owners, BunKit's wrapper table nor RSS grows.
//
//   bun run test/net-soak.ts               # ~20 s
//   SOAK_SECONDS=120 bun run test/net-soak.ts
//
// Under zombies, to catch an over-release of a Network.framework object at the same time:
//   NSZombieEnabled=YES MallocScribble=1 bun run test/net-soak.ts
//
// Each round: a fresh listener on loopback is started and closed (TLS every tenth round; every
// fifth it takes three connections first); ten connections to a long-lived echo listener (its TLS
// twin every tenth round) each exchange a message (1 MiB every fifth round) and are closed — nine
// by the server, one by the client; and a connection to a port nobody listens on is closed while
// it waits. Every twenty-fifth round also advertises a listener with Bonjour and browses for it.
//
// Why mostly the server closes. Whichever end closes first holds its port in TIME_WAIT for 30 s,
// and with both ends on one Mac every port comes from one pool: Network.framework hands a new
// connection a port it has just let go of, and the kernel refuses it while that port is still in
// TIME_WAIT. A server closing first leaves only its own listening port in TIME_WAIT, which nothing
// else is handed; a soak where clients close first runs into that at a few hundred connections a
// second (a connection that does is failed, and `connect` below reconnects, as an app would).

import { stats } from "../src/objc.ts";
import { netStats, PeerBrowser, PeerConnection, PeerListener, type PeerInfo, type TlsPsk } from "../src/net/index.ts";

const SECONDS = Number(process.env.SOAK_SECONDS ?? 20);
let failures = 0;
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const tag = String(process.pid % 100000);
const rssMB = () => Math.round(process.memoryUsage.rss() / (1024 * 1024));
const key: TlsPsk = { psk: crypto.getRandomValues(new Uint8Array(32)), identity: "soak" };

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (!cond() && performance.now() < end) await Bun.sleep(1);
  return cond();
}

let connections = 0;
let listeners = 0;
let advertised = 0;
let messages = 0;
let errors = 0;
let collisions = 0;
let lost = 0;
const problems = new Map<string, number>();

/** The first byte of a message: whether the server closes the connection after echoing it. */
const SERVER_CLOSES = 1;

/** An echo listener on loopback that keeps the connections it has open in `open`. */
function echoListener(tls: TlsPsk | undefined): { listener: PeerListener; open: Set<PeerConnection> } {
  const listener = new PeerListener({ type: `_bksoak${tag}._tcp`, name: "soak", advertise: false, tls });
  listeners++;
  const open = new Set<PeerConnection>();
  listener.onConnection((c) => {
    open.add(c);
    c.onState((s) => {
      if (s === "cancelled") open.delete(c);
    });
    c.onMessage((m) => {
      c.send(m);
      if (m[0] === SERVER_CLOSES) c.close(); // after the echo: a close lets what was sent go first
    });
  });
  return { listener, open };
}

/**
 * A connection to `port`, ready — reconnecting after a pause, as an app would, when its local port
 * is refused as still held in TIME_WAIT (see the note at the top, and net.m). Each one tried is
 * pushed to `tried`, so a stumble still closes them all.
 */
async function connect(port: number, tls: TlsPsk | undefined, tried: PeerConnection[]): Promise<PeerConnection> {
  for (let attempt = 0; ; attempt++) {
    const c = PeerConnection.connect({ host: "127.0.0.1", port }, { tls });
    tried.push(c);
    connections++;
    try {
      await c.opened(5000);
      return c;
    } catch (e) {
      if (attempt >= 5 || !/Address already in use/.test(c.error ?? "")) throw e;
      collisions++;
      await Bun.sleep(50 * (attempt + 1));
    }
  }
}

/** Send one message on `c` and wait for its echo; check its length. */
async function exchange(c: PeerConnection, size: number, first: number): Promise<void> {
  const echo = new Promise<Uint8Array>((resolve) => {
    const off = c.onMessage((m) => {
      off();
      resolve(m);
    });
  });
  const m = new Uint8Array(Math.max(1, size)).fill(7);
  m[0] = first;
  await c.send(m);
  if ((await echo).length !== m.length) throw new Error("an echo came back the wrong length");
  messages++;
}

/** Run `work`, closing everything it opened whether or not it finishes; count what goes wrong. */
async function guarded(opened: PeerConnection[], work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    // Reported, not thrown: a soak that stops at the first stumble says nothing about leaks. A
    // port still in TIME_WAIT through every reconnect is this test's own doing (one Mac, one pool
    // of ports; see the note at the top) and is counted apart; anything else is a failure.
    const text = String(e);
    if (/Address already in use/.test(text)) lost++;
    else {
      errors++;
      problems.set(text, (problems.get(text) ?? 0) + 1);
    }
  } finally {
    // What a stumble leaves open would be a leak of the test's, and would hide one of the transport's.
    for (const c of opened) c.close();
  }
}

const shared = { plain: echoListener(undefined), tls: echoListener(key) };
const sharedPorts = {
  plain: await shared.plain.listener.started(5000),
  tls: await shared.tls.listener.started(5000),
};

async function round(n: number): Promise<void> {
  // A listener of its own, started and closed; every fifth round it takes three connections first.
  const own = echoListener(n % 10 === 0 ? key : undefined);
  const ownOpened: PeerConnection[] = [];
  await guarded(ownOpened, async () => {
    const port = await own.listener.started(5000);
    if (n % 5 === 0) {
      const tls = n % 10 === 0 ? key : undefined;
      const cs = await Promise.all([0, 1, 2].map(() => connect(port, tls, ownOpened)));
      await Promise.all(cs.map((c) => exchange(c, 100, SERVER_CLOSES)));
      if (!(await until(() => cs.every((c) => c.state === "cancelled"), 5000))) throw new Error("a connection did not close");
    }
  });
  own.listener.close();
  await until(() => own.listener.state === "cancelled", 2000);

  // Ten connections to the long-lived echo listener.
  const { open } = n % 10 === 0 ? shared.tls : shared.plain;
  const port = n % 10 === 0 ? sharedPorts.tls : sharedPorts.plain;
  const tls = n % 10 === 0 ? key : undefined;
  const opened: PeerConnection[] = [];
  await guarded(opened, async () => {
    const cs = await Promise.all(Array.from({ length: 10 }, () => connect(port, tls, opened)));
    await Promise.all(cs.map((c, i) => {
      const size = n % 5 === 0 && i === 0 ? 1024 * 1024 : 1 + ((i * 997 + n) % 8192);
      return exchange(c, size, i === 9 ? 0 : SERVER_CLOSES).then(() => {
        if (i === 9) c.close();
      });
    }));
    if (!(await until(() => cs.every((c) => c.state === "cancelled") && open.size === 0, 5000))) {
      throw new Error("not every connection closed");
    }
  });

  // Nobody listens on the round's own port now: the connection waits (refused), and is closed so.
  const refused = PeerConnection.connect({ host: "127.0.0.1", port: own.listener.port ?? 1 });
  connections++;
  await until(() => refused.state === "waiting" || refused.state === "failed", 2000);
  refused.close();
  await until(() => refused.state === "cancelled", 2000);
}

async function bonjourRound(n: number): Promise<void> {
  const type = `_bksoakb${tag}._tcp`;
  const name = `soak ${n}`;
  const listener = new PeerListener({ type, name, txt: { n: String(n) } });
  const browser = new PeerBrowser({ type });
  listeners++;
  advertised++;
  await until(() => browser.peers.some((p: PeerInfo) => p.name === name), 3000);
  listener.close();
  browser.close();
  await until(() => listener.state === "cancelled" && browser.state === "cancelled", 2000);
}

// Warm up, then settle before the baseline: first-use allocations are not a leak.
for (let i = 0; i < 5; i++) await round(i);
await bonjourRound(0);
Bun.gc(true);
await Bun.sleep(100);
Bun.gc(true);
const base = { ...stats(), ...netStats(), rss: rssMB() };
console.log(`  baseline: ${base.live} live wrappers, ${base.native} native net objects (the two echo listeners), ${base.rss} MB RSS`);

const t0 = performance.now();
let rounds = 0;
const samples: Array<{ t: number; rss: number; live: number; native: number }> = [];
while ((performance.now() - t0) / 1000 < SECONDS) {
  await round(rounds);
  if (rounds % 25 === 0) await bonjourRound(rounds);
  rounds++;
  if (rounds % 20 === 0) {
    Bun.gc(true);
    await Bun.sleep(5);
    samples.push({ t: (performance.now() - t0) / 1000, rss: rssMB(), live: stats().live, native: netStats().native });
  }
}

shared.plain.listener.close();
shared.tls.listener.close();
await until(() => netStats().native === 0 && netStats().owners === 0, 5000);
Bun.gc(true);
await Bun.sleep(100);
Bun.gc(true);
const end = { ...stats(), ...netStats(), rss: rssMB() };

console.log(`\n  ${rounds} rounds in ${SECONDS}s: ${listeners} listeners, ${connections} connections, ${advertised} advertised, ${messages} messages`);
console.log(`  connects whose port was still in TIME_WAIT, reconnected: ${collisions}; batches given up on after six: ${lost}`);
console.log(`  live wrappers: ${base.live} -> ${end.live}`);
console.log(`  native net objects now: ${end.native}, JavaScript owners: ${end.owners}`);
console.log(`  RSS: ${base.rss} MB -> ${end.rss} MB`);
console.log(`  samples: ${samples.map((s) => `${s.t.toFixed(0)}s:${s.rss}MB/${s.native}n`).join("  ")}`);

check("did real work", connections > 1000 && listeners > 100, { connections, listeners });
check("every exchange and every close completed", errors === 0, { errors, problems: [...problems] });
check("ports still in TIME_WAIT stayed rare (under 1% of connections)", collisions + lost * 6 < connections / 100, { collisions, lost, connections });
check("every native listener, browser and connection was released", end.native === 0, end.native);
check("JavaScript holds nothing for them", end.owners === 0, end.owners);
check("the wrapper table did not grow", end.live < base.live + 50, `${base.live} -> ${end.live}`);
check("native objects alive at any sample stayed bounded", samples.every((s) => s.native < 64), samples.map((s) => s.native));

const zombies = process.env.NSZombieEnabled === "YES";
const growth = end.rss - base.rss;
if (zombies) {
  console.log(`  (NSZombieEnabled: skipping memory assertions; ${growth} MB retained by design)`);
} else {
  check("RSS growth bounded", growth < 80, `${growth} MB over ${rounds} rounds`);
  if (samples.length >= 4) {
    const mid = samples[Math.floor(samples.length / 2) - 1]!;
    const last = samples[samples.length - 1]!;
    const early = mid.rss - base.rss;
    const late = last.rss - mid.rss;
    console.log(`  first half: +${early} MB, second half: +${late} MB`);
    check("growth is flattening, not linear", late <= Math.max(early, 8) + 6, `${early} then ${late}`);
  }
}

console.log(failures === 0 ? "\nNET SOAK PASSED" : `\n${failures} NET SOAK FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
