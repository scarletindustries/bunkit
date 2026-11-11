#!/usr/bin/env bun
// Try bunkit/net between Macs: run this on each of them.
//
//   bun run tools/peer-check.ts                 advertise, browse, and test every other Mac found
//   bun run tools/peer-check.ts --tls <word>    the same over TLS, keyed from a word both sides use
//   bun run tools/peer-check.ts --no-p2p        leave AWDL out: a shared network or a cable only
//   bun run tools/peer-check.ts --mib 256       how much to send to each peer (default 64)
//
// Each Mac advertises itself under its host name, finds the others, connects to each, and prints
// the route the connection took (awdl0 is AWDL, en0 Wi-Fi or Ethernet), the round trip of a small
// message, and the throughput of a bulk send. Ctrl-C to stop.
//
// To try AWDL — the link AirDrop uses — with no network at all: on both Macs turn Wi-Fi on but
// leave it joined to nothing (Wi-Fi menu ▸ the network ▸ Disconnect, or somewhere none is known),
// unplug Ethernet, and run this on both. Peers show up on `awdl0` and connections report
// `peer-to-peer`. Within a metre or two of each other is plenty; through a wall or two it slows.
// With a shared network or a cable they meet there too, and Network.framework picks the route.
//
// The first run from a terminal asks for the Local Network permission for that terminal app;
// allow it, or nothing is found (see the README).

import { hostname } from "node:os";
import { PeerBrowser, PeerConnection, PeerListener, type PeerInfo, type TlsPsk } from "../src/net/index.ts";

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const word = option("--tls");
const peerToPeer = !argv.includes("--no-p2p");
const mib = Number(option("--mib") ?? 64);
const name = (option("--name") ?? hostname().replace(/\.local\.?$/, "")).slice(0, 60);
const TYPE = "_bkpeercheck._tcp";

/** A key both Macs derive from the same word. Fine for a check; not how to pair for real. */
function keyFrom(w: string): TlsPsk {
  const psk = new Uint8Array(new Bun.CryptoHasher("sha256").update(`bunkit peer-check ${w}`).digest().buffer);
  return { psk, identity: "peer-check" };
}
const tls = word ? keyFrom(word) : undefined;

// The listener's side of a tiny protocol: the first byte says what a message is.
const DATA = 0;
const PING = 1;
const DONE = 2;

const listener = new PeerListener({ type: TYPE, name, txt: { tls: tls ? "1" : "0" }, peerToPeer, tls });
listener.onConnection((c) => {
  let bytes = 0;
  c.onMessage((m) => {
    if (m[0] === PING) c.send(m);
    else if (m[0] === DATA) bytes += m.length;
    else if (m[0] === DONE) {
      c.send(new TextEncoder().encode(String(bytes)));
      bytes = 0;
    }
  });
});
listener.onState((state, error) => {
  if (state === "failed") console.error(`listener failed: ${error}`);
});
const port = await listener.started(10_000);
console.log(`advertising "${listener.name}" (${TYPE}, port ${port}${tls ? ", TLS" : ""}${peerToPeer ? ", AWDL allowed" : ", AWDL off"})`);

const browser = new PeerBrowser({ type: TYPE, peerToPeer, tls });
browser.onState((state, error) => {
  if (state === "waiting" || state === "failed") console.error(`browser ${state}: ${error ?? ""}`);
});

const tested = new Set<string>();
browser.onChange((peers) => {
  for (const peer of peers) {
    if (peer.name === listener.name || tested.has(peer.name)) continue;
    tested.add(peer.name);
    test(peer).catch((e) => console.log(`  ${peer.name}: ${e}`));
  }
});

async function test(peer: PeerInfo): Promise<void> {
  const where = peer.interfaces.map((i) => `${i.name}${i.peerToPeer ? " (AWDL)" : ""}`).join(", ");
  console.log(`found "${peer.name}" on ${where}${peer.txt.tls === "1" ? ", TLS" : ""}`);
  const c = browser.connect(peer);
  await c.opened(15_000);
  const p = c.path;
  const route = p ? `${p.interface ?? "?"}${p.peerToPeer ? ", peer-to-peer" : ""}${p.wired ? ", wired" : ""}` : "?";
  console.log(`  ${peer.name}: connected over ${route}, ${p?.local} -> ${p?.remote}${c.security ? `, ${c.security.protocol}` : ""}`);

  const replies: Uint8Array[] = [];
  c.onMessage((m) => replies.push(m));
  const reply = async () => {
    while (replies.length === 0) {
      if (c.state === "cancelled") throw new Error(`the connection closed: ${c.error ?? ""}`);
      await Bun.sleep(1);
    }
    return replies.shift()!;
  };

  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t = performance.now();
    await c.send(new Uint8Array([PING, i]));
    await reply();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`  ${peer.name}: round trip ${times[25]!.toFixed(2)} ms median, ${times[49]!.toFixed(2)} ms worst`);

  const chunk = new Uint8Array(1024 * 1024);
  chunk[0] = DATA;
  const t0 = performance.now();
  const window: Promise<void>[] = [];
  for (let i = 0; i < mib; i++) {
    window.push(c.send(chunk));
    if (window.length >= 8) await window.shift();
  }
  await Promise.all(window);
  await c.send(new Uint8Array([DONE]));
  const received = Number(new TextDecoder().decode(await reply()));
  const seconds = (performance.now() - t0) / 1000;
  console.log(`  ${peer.name}: ${(received / 1048576).toFixed(0)} MiB in ${seconds.toFixed(2)} s, ${(received / 1048576 / seconds).toFixed(1)} MiB/s over ${c.path?.interface ?? "?"}`);
  c.close();
}

process.on("SIGINT", () => {
  listener.close();
  browser.close();
  setTimeout(() => process.exit(0), 200);
});
