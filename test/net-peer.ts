// The far end of test/net.ts's two-process test: a listener in a process of its own — plain
// Bun, no NSApplication, no pump — that test/net.ts finds with Bonjour and talks to.
//
//   bun run test/net-peer.ts <type> <name>
//
// It echoes every message back, except short text commands starting with "!":
//   !sink        stop echoing; count what arrives instead
//   !count       answer "!count:<messages>:<bytes>" for what was counted
//   !stall:<ms>  hold the main thread that long (a busy show clock), then answer "!stalled"
//   !bye         answer "!bye", close everything and exit 0
// It prints "ready <port>" once listening, and exits 1 if nothing connects within a minute.

import { PeerListener, type PeerConnection } from "../src/net/index.ts";

const [type, name] = process.argv.slice(2);
if (!type || !name) {
  console.error("usage: bun run test/net-peer.ts <type> <name>");
  process.exit(2);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const listener = new PeerListener({ type, name, txt: { pid: String(process.pid), role: "peer" } });
let sink = false;
let counted = 0;
let countedBytes = 0;
let connected = false;

/** A command, if `m` is one: short, and text starting with "!". */
function command(m: Uint8Array): string | undefined {
  if (m.length === 0 || m.length > 64 || m[0] !== 0x21) return undefined;
  return decoder.decode(m);
}

function serve(c: PeerConnection): void {
  connected = true;
  // The test is over (or gone) when its connection is: never linger as an orphan.
  c.onState((state) => {
    if (state === "cancelled") {
      listener.close();
      setTimeout(() => process.exit(0), 200);
    }
  });
  c.onMessage((m) => {
    const cmd = command(m);
    if (cmd === "!sink") {
      sink = true;
    } else if (cmd === "!count") {
      c.send(encoder.encode(`!count:${counted}:${countedBytes}`));
    } else if (cmd?.startsWith("!stall:")) {
      const until = performance.now() + Number(cmd.slice(7));
      while (performance.now() < until) {
        // Hold the main thread, as a long frame would: nothing here is drained meanwhile.
      }
      c.send(encoder.encode("!stalled"));
    } else if (cmd === "!bye") {
      c.send(encoder.encode("!bye")).finally(() => {
        c.close();
        listener.close();
        setTimeout(() => process.exit(0), 200);
      });
    } else if (sink) {
      counted++;
      countedBytes += m.length;
    } else {
      c.send(m);
    }
  });
}

listener.onConnection(serve);
listener.onState((state, error) => {
  if (state === "failed") {
    console.error(`net-peer: the listener failed: ${error}`);
    process.exit(1);
  }
});
const port = await listener.started(10_000);
console.log(`ready ${port}`);
setTimeout(() => {
  if (!connected) {
    console.error("net-peer: nothing connected within a minute");
    process.exit(1);
  }
}, 60_000);
