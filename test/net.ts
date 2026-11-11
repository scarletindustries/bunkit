// Peer-to-peer connections (src/net, native/src/net.m), on one Mac with no network needed.
//
// A listener and a browser in one process find each other with Bonjour over loopback and the
// local domain, peer-to-peer on; whole messages of 0 B, 1 B, 64 KiB and 16 MiB go both ways in
// order and intact; many are pipelined under backpressure; either end can close and the other
// sees it; an oversized or truncated frame fails the connection with a reason; TLS with a
// pre-shared key works and a wrong key, a wrong identity or a missing one does not; the TXT
// record is read before connecting. Then a second bun process is the listener, found and talked
// to across processes, and stalled to show the backpressure reaching back to the sender.
//
// Everything is on unique service types, so parallel runs (or another app's services) never
// meet. The Bonjour sections advertise on every interface, as an app would: mDNSResponder
// answers on the local link. The rest listen unadvertised and connect to 127.0.0.1.

import { networkInterfaces } from "node:os";
import {
  encodeTxt,
  MAX_MESSAGE_BYTES,
  netStats,
  PeerBrowser,
  PeerConnection,
  PeerListener,
  type PeerInfo,
  type TlsPsk,
} from "../src/net/index.ts";

let failures = 0;
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const tag = String(process.pid % 100000);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `n` bytes that depend on `seed` and their position. */
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

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (!cond() && performance.now() < end) await Bun.sleep(2);
  return cond();
}

/** The next `count` messages on `c`, in order. */
function collect(c: PeerConnection, count: number): Promise<Uint8Array[]> {
  return new Promise((resolve) => {
    const got: Uint8Array[] = [];
    const off = c.onMessage((m) => {
      got.push(m);
      if (got.length === count) {
        off();
        resolve(got);
      }
    });
  });
}

/** A listener on loopback, not advertised, that echoes every message. */
async function echoListener(options: Partial<ConstructorParameters<typeof PeerListener>[0]> = {}) {
  const listener = new PeerListener({ type: `_bkecho${tag}._tcp`, name: "echo", advertise: false, ...options });
  const accepted: PeerConnection[] = [];
  listener.onConnection((c) => {
    accepted.push(c);
    c.onMessage((m) => {
      c.send(m);
    });
  });
  const port = await within(listener.started(), 5000, "the echo listener");
  return { listener, accepted, port };
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------
{
  check("MAX_MESSAGE_BYTES is 16 MiB", MAX_MESSAGE_BYTES === 16 * 1024 * 1024);
  const txt = encodeTxt({ a: "1", role: "stage" });
  check("a TXT record is length-prefixed key=value", txt.length === 4 + 11 && txt[0] === 3 && decoder.decode(txt.subarray(1, 4)) === "a=1");
  check("an empty TXT record is empty", encodeTxt({}).length === 0 && encodeTxt(undefined).length === 0);
  const throws = (fn: () => unknown, type: Function) => {
    try {
      fn();
      return false;
    } catch (e) {
      return e instanceof type;
    }
  };
  check("a TXT key with = is refused", throws(() => encodeTxt({ "a=b": "1" }), TypeError));
  check("an empty TXT key is refused", throws(() => encodeTxt({ "": "1" }), TypeError));
  check("a TXT entry over 255 bytes is refused", throws(() => encodeTxt({ k: "x".repeat(260) }), RangeError));
  check("a malformed service type is refused", throws(() => new PeerListener({ type: "hiettlight", name: "x" }), TypeError));
  check("a UDP service type is refused", throws(() => new PeerBrowser({ type: "_x._udp" }), TypeError));
  check("a name over 63 bytes is refused", throws(() => new PeerListener({ type: "_x._tcp", name: "n".repeat(64) }), RangeError));
  check("a limit over 16 MiB is refused", throws(() => new PeerListener({ type: "_x._tcp", name: "x", maxMessageBytes: MAX_MESSAGE_BYTES + 1 }), RangeError));
  check("a short key is refused", throws(() => new PeerListener({ type: "_x._tcp", name: "x", tls: { psk: new Uint8Array(8), identity: "a" } }), RangeError));
  check("nothing was started by the refusals", netStats().native === 0, netStats());
}

// ---------------------------------------------------------------------------
// Discovery: a listener and a browser in one process
// ---------------------------------------------------------------------------
let discoveryListener: PeerListener | undefined;
let discoveryBrowser: PeerBrowser | undefined;
{
  const type = `_bkt${tag}._tcp`;
  const name = `BunKit test ${tag}`;
  const listener = new PeerListener({ type, name, txt: { role: "stage", pid: String(process.pid) } });
  discoveryListener = listener;
  const accepted: PeerConnection[] = [];
  listener.onConnection((c) => {
    accepted.push(c);
    c.onMessage((m) => {
      c.send(m);
    });
  });
  const port = await within(listener.started(), 5000, "the listener");
  check("the listener is ready on a port", listener.state === "ready" && port > 0 && listener.port === port, port);
  check("it advertises under the name asked for", listener.name === name, listener.name);

  const browser = new PeerBrowser({ type });
  discoveryBrowser = browser;
  const t0 = performance.now();
  const peer = await within(new Promise<PeerInfo>((resolve) => {
    const look = (peers: readonly PeerInfo[]) => {
      const p = peers.find((x) => x.name === name);
      if (p) resolve(p);
    };
    browser.onChange(look);
    look(browser.peers);
  }), 10_000, "discovery");
  console.log(`  (found in ${(performance.now() - t0).toFixed(0)} ms on ${peer.interfaces.map((i) => i.name).join(", ")})`);
  check("the browser is ready", browser.state === "ready", browser.state);
  check("the peer is in the local domain", peer.domain === "local.", peer.domain);
  check("its type is the one browsed", peer.type.replace(/\.$/, "") === type, peer.type);
  check("its TXT record is read before connecting", peer.txt.role === "stage" && peer.txt.pid === String(process.pid), peer.txt);
  check("it is seen over loopback", peer.interfaces.some((i) => i.type === "loopback"), peer.interfaces);
  check("browser.peers holds it", browser.peers.some((p) => p.name === name));

  // Peer-to-peer is on by default on both ends: where this Mac has AWDL up, the peer is seen on
  // it — and, with it off at either end, is not.
  const awdl = Object.keys(networkInterfaces()).some((n) => n.startsWith("awdl"));
  if (awdl) {
    await until(() => browser.peers.find((p) => p.name === name)?.interfaces.some((i) => i.peerToPeer) ?? false, 3000);
    const now = browser.peers.find((p) => p.name === name);
    check("with AWDL up, the peer is seen over it", now?.interfaces.some((i) => i.peerToPeer && i.name.startsWith("awdl")), now?.interfaces);
    const off = new PeerBrowser({ type, peerToPeer: false });
    await until(() => off.peers.some((p) => p.name === name), 5000);
    await Bun.sleep(1000);
    const seen = off.peers.find((p) => p.name === name);
    check("a browser with peer-to-peer off sees it, but not over AWDL", seen && !seen.interfaces.some((i) => i.peerToPeer), seen?.interfaces);
    off.close();
  } else {
    console.log("  (AWDL is down on this Mac — Wi-Fi off? — so the peer-to-peer checks are skipped)");
  }

  // A new TXT record reaches the browser without reconnecting anything.
  const changed = within(new Promise<PeerInfo>((resolve) => {
    browser.onChange((peers) => {
      const p = peers.find((x) => x.name === name);
      if (p?.txt.v === "2") resolve(p);
    });
  }), 10_000, "the TXT change");
  listener.setTxt({ role: "stage", pid: String(process.pid), v: "2" });
  const updated = await changed.catch((e) => e as Error);
  check("setTxt re-advertises, and the browser sees it", !(updated instanceof Error) && updated.txt.v === "2", updated);

  // Connect through the browser, and exchange the four sizes both ways.
  const c = browser.connect(peer);
  await within(c.opened(), 10_000, "connecting through the browser");
  check("the connection is ready", c.state === "ready");
  check("it reports the path it took", c.path !== undefined && typeof c.path.wired === "boolean" && typeof c.path.peerToPeer === "boolean", c.path);
  console.log(`  (path: ${c.path?.interface} ${c.path?.interfaceType}, ${c.path?.local} -> ${c.path?.remote})`);
  // Which interface a connection to this Mac takes is Network.framework's choice — loopback, Wi-Fi
  // or AWDL have all been seen — so what is checked is that the path describes itself truthfully.
  check("the path says peer-to-peer exactly when it is over AWDL", c.path?.peerToPeer === /^(awdl|llw)/.test(c.path?.interface ?? ""), c.path);
  check("and wired exactly when the interface is", c.path?.wired === (c.path?.interfaceType === "wired"), c.path);
  check("it is plain, without TLS", c.security === undefined);
  await until(() => accepted.length === 1, 2000);
  check("the listener handed over one ready connection", accepted.length === 1 && accepted[0]!.state === "ready");

  const sizes = [0, 1, 64 * 1024, 16 * 1024 * 1024];
  const messages = sizes.map((n, i) => pattern(n, i + 1));
  const echoes = collect(c, sizes.length);
  const sends = messages.map((m) => c.send(m));
  check("bufferedAmount counts what is not yet taken", c.bufferedAmount > 0 && c.bufferedAmount <= 16 * 1024 * 1024 + 64 * 1024 + 1, c.bufferedAmount);
  await within(Promise.all(sends), 10_000, "the sends");
  const back = await within(echoes, 10_000, "the echoes");
  sizes.forEach((n, i) => check(`a ${n}-byte message goes there and back, intact and in order`, same(back[i]!, messages[i]!), back[i]?.length));
  check("bufferedAmount is back to 0", c.bufferedAmount === 0, c.bufferedAmount);
  c.close();
  await until(() => accepted[0]!.state === "cancelled", 3000);
  check("closing it reaches the listener's end", accepted[0]!.state === "cancelled", accepted[0]!.state);
}

// ---------------------------------------------------------------------------
// Pipelining and backpressure
// ---------------------------------------------------------------------------
{
  const { listener, port } = await echoListener();
  const c = PeerConnection.connect({ host: "127.0.0.1", port });
  await within(c.opened(), 5000, "connecting to 127.0.0.1");
  check("a connection by address takes loopback", c.path?.loopback === true, c.path);

  // 2000 messages of mixed sizes, each carrying its own number, at most 4 MiB in flight.
  const N = 2000;
  const sent: Uint8Array[] = [];
  const order: number[] = [];
  let maxBuffered = 0;
  const echoes = collect(c, N);
  const all: Promise<void>[] = [];
  const window: Promise<void>[] = [];
  for (let i = 0; i < N; i++) {
    const size = 4 + ((i * 7919) % (64 * 1024));
    const m = pattern(size, i + 100);
    new DataView(m.buffer).setUint32(0, i);
    sent.push(m);
    const p = c.send(m).then(() => {
      order.push(i);
    });
    all.push(p);
    window.push(p);
    maxBuffered = Math.max(maxBuffered, c.bufferedAmount);
    // Backpressure: past 4 MiB in flight, wait for the oldest send to be taken.
    while (c.bufferedAmount > 4 * 1024 * 1024) await window.shift();
  }
  await within(Promise.all(all), 20_000, "the pipelined sends");
  const back = await within(echoes, 20_000, "the pipelined echoes");
  check("every send resolved, in the order sent", order.length === N && order.every((v, i) => v === i), order.slice(0, 10));
  check("bufferedAmount stayed near the window", maxBuffered <= 4 * 1024 * 1024 + 64 * 1024, maxBuffered);
  check("2000 pipelined messages come back in order and intact", back.length === N && back.every((m, i) => same(m, sent[i]!)));
  c.close();
  listener.close();
}

// ---------------------------------------------------------------------------
// Closing, from either end
// ---------------------------------------------------------------------------
{
  const { listener, accepted, port } = await echoListener();

  // The client closes: the server's end sees it.
  const a = PeerConnection.connect({ host: "127.0.0.1", port });
  await within(a.opened(), 5000, "connection a");
  await until(() => accepted.length === 1, 2000);
  const serverA = accepted[0]!;
  const serverStates: string[] = [];
  let serverReason: string | undefined;
  serverA.onState((s, e) => {
    serverStates.push(s);
    if (s === "cancelled") serverReason = e;
  });
  a.close();
  await until(() => serverA.state === "cancelled" && a.state === "cancelled", 3000);
  check("a client's close cancels it here", a.state === "cancelled");
  check("and the server's end sees it closed by the peer", serverA.state === "cancelled" && /peer closed/i.test(serverReason ?? ""), { serverStates, serverReason });
  const after = await a.send(new Uint8Array(1)).then(() => "sent", (e) => String(e));
  check("sending on a closed connection rejects", /closed/.test(after), after);

  // The server closes: the client sees it.
  const b = PeerConnection.connect({ host: "127.0.0.1", port });
  let clientReason: string | undefined;
  b.onState((s, e) => {
    if (s === "cancelled") clientReason = e;
  });
  await within(b.opened(), 5000, "connection b");
  await until(() => accepted.length === 2, 2000);
  accepted[1]!.close();
  await until(() => b.state === "cancelled", 3000);
  check("a server's close reaches the client", b.state === "cancelled" && /peer closed/i.test(clientReason ?? ""), { state: b.state, clientReason });

  // A close lets what was sent go first: 16 MiB, then close at once, without waiting.
  const c = PeerConnection.connect({ host: "127.0.0.1", port });
  await within(c.opened(), 5000, "connection c");
  await until(() => accepted.length === 3, 2000);
  const serverC = accepted[2]!;
  const big = pattern(16 * 1024 * 1024, 77);
  const arrived = within(new Promise<Uint8Array>((resolve) => serverC.onMessage(resolve)), 5000, "the message sent before close");
  const sendResult = c.send(big).then(() => "sent", (e) => String(e));
  c.close();
  const got = await arrived.catch((e) => e as Error);
  check("a message sent just before close still arrives whole", !(got instanceof Error) && same(got, big), got instanceof Error ? got.message : got.length);
  check("and its send resolved", (await sendResult) === "sent");
  await until(() => serverC.state === "cancelled", 3000);
  check("then the close arrives", serverC.state === "cancelled", serverC.state);
  listener.close();
}

// ---------------------------------------------------------------------------
// Oversized and truncated frames
// ---------------------------------------------------------------------------
{
  // The sender refuses before sending anything.
  const { listener: plain, port: plainPort } = await echoListener();
  const c = PeerConnection.connect({ host: "127.0.0.1", port: plainPort });
  await within(c.opened(), 5000, "connecting");
  const over = await c.send(new Uint8Array(MAX_MESSAGE_BYTES + 1)).then(() => "sent", (e) => e);
  check("a message over 16 MiB is refused by send", over instanceof RangeError, over);
  check("and the connection is still fine", c.state === "ready");
  const echo = collect(c, 1);
  await c.send(encoder.encode("still here"));
  check("it still carries messages", decoder.decode((await within(echo, 3000, "echo"))[0]!) === "still here");
  c.close();
  plain.close();

  // The receiver refuses: a listener with a 1 KiB limit, sent 2 KiB by a client with a larger one.
  const small = new PeerListener({ type: `_bksmall${tag}._tcp`, name: "small", advertise: false, maxMessageBytes: 1024 });
  const inbound: PeerConnection[] = [];
  const reasons: string[] = [];
  small.onConnection((x) => {
    inbound.push(x);
    x.onState((s, e) => {
      if (s === "failed" && e) reasons.push(e);
    });
  });
  const smallPort = await within(small.started(), 5000, "the small listener");
  const d = PeerConnection.connect({ host: "127.0.0.1", port: smallPort });
  await within(d.opened(), 5000, "connecting to the small listener");
  await d.send(new Uint8Array(1024)); // at the limit: fine
  await d.send(new Uint8Array(2048)); // over it
  await until(() => d.state === "cancelled", 3000);
  check("a frame over the receiver's limit fails its end", reasons.some((r) => /2048 bytes.*limit of 1024/.test(r)), reasons);
  check("and closes the sender's", d.state === "cancelled", d.state);

  // A raw socket: an absurd length, and a peer that closes mid-message.
  async function raw(bytes: number[], end: boolean): Promise<{ closed: boolean }> {
    const result = { closed: false };
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: smallPort,
      socket: { data() {}, close() { result.closed = true; } },
    });
    socket.write(new Uint8Array(bytes));
    socket.flush();
    if (end) socket.end();
    await until(() => result.closed, 3000);
    if (!result.closed) socket.end();
    return result;
  }
  const before = reasons.length;
  const huge = await raw([0xff, 0xff, 0xff, 0xff], false);
  await until(() => reasons.length > before, 3000);
  check("a 4 GiB length from a raw socket is refused", reasons.slice(before).some((r) => /4294967295 bytes/.test(r)), reasons.slice(before));
  check("and the raw socket is closed on", huge.closed);
  const mid = reasons.length;
  await raw([0, 0, 0, 100, 1, 2, 3, 4, 5], true);
  await until(() => reasons.length > mid, 3000);
  check("a peer closing in the middle of a message fails the connection", reasons.slice(mid).some((r) => /middle of a message/.test(r)), reasons.slice(mid));
  small.close();
}

// ---------------------------------------------------------------------------
// TLS with pre-shared keys
// ---------------------------------------------------------------------------
{
  const k1 = { psk: crypto.getRandomValues(new Uint8Array(32)), identity: `pair-${tag}-1` };
  const k2 = { psk: crypto.getRandomValues(new Uint8Array(32)), identity: `pair-${tag}-2` };
  const { listener, accepted, port } = await echoListener({ tls: [k1, k2] });

  const a = PeerConnection.connect({ host: "127.0.0.1", port }, { tls: k1 });
  await within(a.opened(), 5000, "TLS with the first key");
  check("TLS with a pre-shared key connects", a.state === "ready");
  check("it negotiated TLS 1.2 with ECDHE-PSK ChaCha20-Poly1305", a.security?.protocol === "TLS 1.2" && a.security.ciphersuite === 0xccac, a.security);
  const echo = collect(a, 2);
  await a.send(encoder.encode("over tls"));
  const big = pattern(16 * 1024 * 1024, 5);
  await a.send(big);
  const back = await within(echo, 10_000, "the TLS echo");
  check("messages go there and back over TLS, 16 MiB included", decoder.decode(back[0]!) === "over tls" && same(back[1]!, big));

  const b = PeerConnection.connect({ host: "127.0.0.1", port }, { tls: k2 });
  await within(b.opened(), 5000, "TLS with the second key").catch(() => {});
  check("a listener holding two keys takes either", b.state === "ready", b.error);

  async function refused(tls: TlsPsk | undefined, to = port) {
    const c = PeerConnection.connect({ host: "127.0.0.1", port: to }, { tls });
    const outcome = await c.opened(5000).then(() => "ready", (e) => String(e));
    // Plain TCP is ready before anything is said: say something, for the far end to object to.
    if (outcome === "ready") c.send(encoder.encode("hello"));
    await until(() => c.state === "cancelled", 3000);
    return { outcome, error: c.error, state: c.state };
  }
  const wrongKey = await refused({ psk: crypto.getRandomValues(new Uint8Array(32)), identity: k1.identity });
  check("a wrong key fails to connect", wrongKey.outcome !== "ready" && wrongKey.state === "cancelled" && /TLS|MAC/i.test(wrongKey.error ?? ""), wrongKey);
  const wrongIdentity = await refused({ psk: k1.psk, identity: "someone else" });
  check("an unknown identity fails to connect", wrongIdentity.outcome !== "ready" && /identity|TLS/i.test(wrongIdentity.error ?? ""), wrongIdentity);
  const noKey = await refused(undefined);
  check("a client with no key is turned away", noKey.outcome === "ready" ? noKey.state === "cancelled" : true, noKey);
  await Bun.sleep(200);
  check("the listener handed over only the two good connections", accepted.length === 2, accepted.length);

  const { listener: plain, port: plainPort } = await echoListener();
  const tlsToPlain = await refused(k1, plainPort);
  check("a client with a key fails against a listener without one", tlsToPlain.outcome !== "ready" || tlsToPlain.state === "cancelled", tlsToPlain);
  a.close();
  b.close();
  listener.close();
  plain.close();
}

// ---------------------------------------------------------------------------
// The main thread during a long transfer
// ---------------------------------------------------------------------------
{
  const sink = new PeerListener({ type: `_bksink${tag}._tcp`, name: "sink", advertise: false });
  let received = 0;
  sink.onConnection((x) => x.onMessage((m) => {
    received += m.length;
  }));
  const sinkPort = await within(sink.started(), 5000, "the sink");
  const c = PeerConnection.connect({ host: "127.0.0.1", port: sinkPort });
  await within(c.opened(), 5000, "connecting to the sink");
  const total = 256 * 1024 * 1024;
  const chunk = pattern(1024 * 1024, 9);
  let last = performance.now();
  let worst = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  const t0 = performance.now();
  const window: Promise<void>[] = [];
  for (let sent = 0; sent < total; sent += chunk.length) {
    window.push(c.send(chunk));
    if (window.length >= 8) await window.shift();
  }
  await until(() => received >= total, 20_000);
  const seconds = (performance.now() - t0) / 1000;
  clearInterval(probe);
  console.log(`  (256 MiB over loopback in ${(seconds * 1000).toFixed(0)} ms, ${(total / 1048576 / seconds).toFixed(0)} MiB/s; a 1 ms timer's worst gap ${worst.toFixed(1)} ms)`);
  check("256 MiB arrives", received === total, received);
  check("the main thread kept running throughout (worst 1 ms-timer gap under 50 ms)", worst < 50, worst);
  c.close();
  sink.close();
}

// ---------------------------------------------------------------------------
// Two processes
// ---------------------------------------------------------------------------
{
  const type = `_bkp${tag}._tcp`;
  const name = `BunKit peer ${tag}`;
  const child = Bun.spawn({
    cmd: [process.execPath, "run", new URL("./net-peer.ts", import.meta.url).pathname, type, name],
    stdout: "pipe",
    stderr: "inherit",
  });
  const browser = new PeerBrowser({ type });
  try {
    const peer = await within(new Promise<PeerInfo>((resolve) => {
      browser.onChange((peers) => {
        const p = peers.find((x) => x.name === name);
        if (p) resolve(p);
      });
    }), 15_000, "discovering the other process");
    check("another process's listener is found", peer.name === name);
    check("its TXT record names that process", peer.txt.pid === String(child.pid) && peer.txt.role === "peer", peer.txt);

    const c = browser.connect(peer);
    await within(c.opened(), 10_000, "connecting to the other process");
    check("and connected to", c.state === "ready");
    const replies: Uint8Array[] = [];
    c.onMessage((m) => replies.push(m));
    const next = async (ms: number) => {
      const end = performance.now() + ms;
      while (replies.length === 0 && performance.now() < end) await Bun.sleep(2);
      return replies.shift();
    };

    for (const n of [0, 1, 64 * 1024, 16 * 1024 * 1024]) {
      const m = pattern(n, n + 3);
      await c.send(m);
      const r = await next(10_000);
      check(`a ${n}-byte message goes to the other process and back intact`, r !== undefined && same(r, m), r?.length);
    }

    // Stall the other process's main thread, and keep sending: its native side stops reading
    // at its high-water mark, TCP's window closes, and our sends stop completing.
    await c.send(encoder.encode("!sink"));
    await c.send(encoder.encode("!stall:2500"));
    const total = 192 * 1024 * 1024;
    const chunk = pattern(1024 * 1024, 11);
    let completed = 0;
    const t0 = performance.now();
    const sends: Promise<void>[] = [];
    const window: Promise<void>[] = [];
    let at1200 = -1;
    let at2200 = -1;
    const sampler = setInterval(() => {
      const t = performance.now() - t0;
      if (at1200 < 0 && t >= 1200) at1200 = completed;
      if (at2200 < 0 && t >= 2200) at2200 = completed;
    }, 5);
    for (let sent = 0; sent < total; sent += chunk.length) {
      const p = c.send(chunk).then(() => {
        completed += chunk.length;
      });
      sends.push(p);
      window.push(p);
      while (c.bufferedAmount > 32 * 1024 * 1024) await window.shift();
    }
    await within(Promise.all(sends), 20_000, "the sends after the stall");
    clearInterval(sampler);
    const stalled = await next(5000);
    const mib = (n: number) => `${(n / 1048576).toFixed(0)} MiB`;
    console.log(`  (completed while the peer was stalled: ${mib(at1200)} at 1.2 s, ${mib(at2200)} at 2.2 s, of ${mib(total)})`);
    check("while the peer is stalled, sends stop completing", at1200 >= 0 && at2200 >= 0 && at2200 < total && at2200 - at1200 < 8 * 1024 * 1024, { at1200, at2200 });
    check("its stall ended", stalled !== undefined && decoder.decode(stalled) === "!stalled");
    await c.send(encoder.encode("!count"));
    const count = await next(10_000);
    check("then everything arrives", count !== undefined && decoder.decode(count) === `!count:${total / chunk.length}:${total}`, count && decoder.decode(count));

    await c.send(encoder.encode("!bye"));
    const bye = await next(5000);
    check("the other process says goodbye", bye !== undefined && decoder.decode(bye) === "!bye");
    await until(() => c.state === "cancelled", 3000);
    check("and its close reaches this one", c.state === "cancelled", c.state);
    const code = await within(child.exited, 5000, "the other process exiting");
    check("the other process exits cleanly", code === 0, code);
  } catch (e) {
    check("the two-process test ran", false, e);
    child.kill();
  } finally {
    browser.close();
  }
}

// ---------------------------------------------------------------------------
// Inside BunKit's run loop, as an app runs it
// ---------------------------------------------------------------------------
/** Median and worst round trip of `n` small messages on `c`, ms. */
async function pingPong(c: PeerConnection, n: number): Promise<{ median: number; worst: number }> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const back = collect(c, 1);
    const t = performance.now();
    await c.send(encoder.encode(`ping ${i}`));
    await within(back, 2000, "a ping's echo");
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(n / 2)]!, worst: times[n - 1]! };
}
{
  const { listener, port } = await echoListener();
  const c = PeerConnection.connect({ host: "127.0.0.1", port });
  await within(c.opened(), 5000, "connecting");
  const plain = await pingPong(c, 200);

  const { initApp, run, quit, ActivationPolicy } = await import("../src/runtime.ts");
  initApp(ActivationPolicy.Accessory);
  const loop = run({ activationPolicy: ActivationPolicy.Accessory, quitAfterLastWindow: false });
  await pingPong(c, 20); // the application finishing its launch is not the transport's time
  const pumped = await pingPong(c, 200);
  const big = pattern(16 * 1024 * 1024, 21);
  const echo = collect(c, 1);
  await c.send(big);
  const back = await within(echo, 10_000, "16 MiB inside the run loop").catch(() => undefined);
  quit();
  await loop;
  console.log(`  (round trip of a small message: median ${plain.median.toFixed(2)} ms / worst ${plain.worst.toFixed(2)} ms in plain Bun; ${pumped.median.toFixed(2)} / ${pumped.worst.toFixed(2)} ms inside BunKit's run loop)`);
  check("messages flow while BunKit's run loop owns the main thread", back !== undefined && same(back[0]!, big));
  check("a round trip inside the run loop takes well under a pump timeout (4 ms)", pumped.median < 2, pumped);
  c.close();
  listener.close();
}

// ---------------------------------------------------------------------------
// Everything is let go
// ---------------------------------------------------------------------------
discoveryListener?.close();
discoveryBrowser?.close();
await until(() => netStats().native === 0 && netStats().owners === 0, 5000);
check("every listener, browser and connection is released", netStats().native === 0 && netStats().owners === 0, netStats());

console.log(failures === 0 ? "\nNET TESTS PASSED" : `\n${failures} NET TEST FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
