// Peer-to-peer connections between Macs, on Network.framework.
//
//   import { PeerListener, PeerBrowser } from "bunkit/net";
//
//   const listener = new PeerListener({ type: "_myapp._tcp", name: "Stage Mac", txt: { v: "1" } });
//   listener.onConnection((c) => c.onMessage((m) => c.send(m)));      // an echo server
//
//   const browser = new PeerBrowser({ type: "_myapp._tcp" });
//   browser.onChange((peers) => {
//     const c = browser.connect(peers[0]!);
//     c.onMessage((m) => console.log(new TextDecoder().decode(m)));
//     c.send(new TextEncoder().encode("hello"));
//   });
//
// A listener advertises itself with Bonjour; a browser finds every listener of a type nearby,
// with its TXT record, before connecting; a connection carries whole messages, in order, both
// ways. Peer-to-peer interfaces are on by default, so two Macs find each other over AWDL (the
// link AirDrop uses) with Wi-Fi on and no network joined, as well as over a shared Wi-Fi network,
// an Ethernet cable, or loopback — whichever works, without being told.
//
// Messages are framed as a 4-byte big-endian length and the bytes, over TCP — or over TLS with a
// pre-shared key when `tls` is given: TLS 1.2, TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256 (the key
// authenticates both ends, each connection gets its own ephemeral secret). TLS 1.3 with an external
// pre-shared key fails its handshake on macOS 26.6 in every configuration tried; see net.m. A message is at most `MAX_MESSAGE_BYTES` (16 MiB), checked
// by the sender before it is sent and by the receiver before it is read; a peer that sends a
// longer one, or closes in the middle of one, has its connection failed with a message saying so.
//
// Threading. Network.framework runs on a private serial queue in native/src/net.m, never on the
// main thread: the reading, the framing and the copy into each message happen there, and
// JavaScript only ever sees whole messages, taken in batches. When there is something to take,
// the native side signals BunKit's main loop, whose turns run inside the pump and inside every
// nested loop AppKit enters from event dispatch, so a peer's messages are delivered on the main
// thread during a menu, a live resize or a slider drag (docs/main-loop/spec.md §7.5). It also
// wakes Bun's event loop with a `threadsafe` bun:ffi callback, for a script that never pumps, and
// for net used from a thread, where its deliveries run on that thread's loop. Nothing here waits: `send` copies the message and returns, and its
// promise resolves when Network.framework has taken it — which is the backpressure. A received
// message is wrapped, not copied: the buffer the native side assembled it in becomes the
// `Uint8Array`'s memory, freed when it is collected.
//
// Every object here stays open until it is closed, by either end — dropping it does not close
// it, the same as a socket.

import { isMainThread } from "node:worker_threads";
import { lib, cstr, readCString, asPointer, FFIType, JSCallback, toArrayBuffer, type BunPointer } from "../bridge.ts";
import { addTurnSource, Pending, requestTurn, runInTurn, takePending } from "../mainloop.ts";

/** A native listener, browser or connection (net.m): a heap address, never an Obj-C object. */
type Handle = BunPointer;

/** The largest message either end will send or accept: 16 MiB. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** A pre-shared key and the identity it goes by. Both ends must hold the same pair. */
export interface TlsPsk {
  /** The key: at least 16 bytes (32 random bytes, or a derived secret, is the norm). */
  psk: Uint8Array;
  /** What the key is called on the wire, so a listener holding several can pick one. Not secret. */
  identity: string;
}

/** How an interface reaches the network, as Network.framework classifies it. */
export type InterfaceType = "wifi" | "wired" | "cellular" | "loopback" | "other";

/** One interface a peer was found on. */
export interface PeerInterface {
  /** The BSD name: `en0`, `awdl0`, `lo0`… */
  name: string;
  type: InterfaceType;
  /** Whether it is AWDL, the peer-to-peer Wi-Fi link (`awdl0`, `llw0`). */
  peerToPeer: boolean;
}

/** A service a browser has found. Plain data: it can be kept, compared and logged. */
export interface PeerInfo {
  /** The instance name it advertises, e.g. the Mac's name. Unique per type and domain. */
  readonly name: string;
  /** The Bonjour type, e.g. `_hiettlight._tcp.` (Bonjour adds the trailing dot). */
  readonly type: string;
  /** The domain, `local.` for everything nearby. */
  readonly domain: string;
  /** Its TXT record: small metadata, readable before connecting. */
  readonly txt: Readonly<Record<string, string>>;
  /** The interfaces it has been seen on. With AWDL and Wi-Fi both up, often more than one. */
  readonly interfaces: readonly PeerInterface[];
}

/** The route a connection took. */
export interface ConnectionPath {
  /** The interface it runs over, e.g. `awdl0`, `en0`, `lo0`. */
  interface?: string;
  interfaceType: InterfaceType;
  /** Over AWDL. */
  peerToPeer: boolean;
  /** Over an Ethernet cable (or a USB/Thunderbolt Ethernet adaptor). */
  wired: boolean;
  /** Over loopback: the peer is this Mac. */
  loopback: boolean;
  /** This end's address and port, e.g. `fe80::1%awdl0:52011`. */
  local?: string;
  /** The far end's. */
  remote?: string;
}

/** What TLS negotiated, on a connection that has it. */
export interface ConnectionSecurity {
  /** `"TLS 1.2"`: what this module negotiates (see the note at the top). */
  protocol: string;
  /** The IANA cipher suite number: 0xCCAC, TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256. */
  ciphersuite: number;
}

/**
 * A connection's state: Network.framework's, named. `"waiting"` means there is no route now (the
 * peer is out of reach, or refused) and it keeps trying by itself when the network changes;
 * `"failed"` means trying again cannot help — a wrong key, a broken frame, a reset — and is always
 * followed by `"cancelled"`. A caller that wants a peer back reconnects after either.
 */
export type ConnectionState = "preparing" | "ready" | "waiting" | "failed" | "cancelled";

/** A listener's state. A listener waiting for a network reports `"starting"`, with the reason. */
export type ListenerState = "starting" | "ready" | "failed" | "cancelled";

/** A browser's state. `"waiting"` with a reason is usually a missing Local Network permission. */
export type BrowserState = "starting" | "ready" | "waiting" | "failed" | "cancelled";

/** Options for a connection, from {@link PeerBrowser.connect} or {@link PeerConnection.connect}. */
export interface ConnectOptions {
  /** TLS (1.2, ECDHE-PSK) with this pre-shared key. Both ends must have it; without it, plain TCP. */
  tls?: TlsPsk;
  /** Allow AWDL. Default true. */
  peerToPeer?: boolean;
  /** The largest message accepted from the peer, and sent to it. Default and most: 16 MiB. */
  maxMessageBytes?: number;
}

/** Options for a {@link PeerListener}. */
export interface ListenerOptions {
  /** The Bonjour type, `_name._tcp`: an underscore, up to 15 letters, digits or hyphens. */
  type: string;
  /** The instance name others see, e.g. the Mac's name. At most 63 bytes of UTF-8. */
  name: string;
  /**
   * Advertise with Bonjour. Default true. Off, it is a plain listener reached by address
   * ({@link PeerConnection.connect} with `{ host, port }`) — which never involves mDNS, so never
   * the Local Network permission when the peer is this Mac.
   */
  advertise?: boolean;
  /** Small metadata, readable by browsers before connecting. Each `key=value` at most 255 bytes. */
  txt?: Record<string, string>;
  /** Advertise and accept over AWDL too. Default true. */
  peerToPeer?: boolean;
  /**
   * Accept only TLS connections with one of these pre-shared keys. A listener holding several
   * (one per paired peer) picks by identity. Fixed for the listener's life: a new key set is a new
   * listener.
   */
  tls?: TlsPsk | readonly TlsPsk[];
  /** The largest message accepted from a peer, and sent to one. Default and most: 16 MiB. */
  maxMessageBytes?: number;
  /** A fixed port. Default: any free one, which Bonjour advertises. */
  port?: number;
}

/** Options for a {@link PeerBrowser}. */
export interface BrowserOptions {
  /** The Bonjour type to look for, `_name._tcp`. */
  type: string;
  /** Look over AWDL too. Default true. */
  peerToPeer?: boolean;
  /** The default for {@link PeerBrowser.connect}: TLS with this pre-shared key. */
  tls?: TlsPsk;
  /** The default for {@link PeerBrowser.connect}'s largest message. */
  maxMessageBytes?: number;
}

// ---------------------------------------------------------------------------
// The native side's numbers (native/src/net.m). BunKit's own, not Network.framework's.
// ---------------------------------------------------------------------------

const EV_CONN_STATE = 1;
const EV_CONN_MESSAGE = 2;
const EV_CONN_SENT = 3;
const EV_CONN_INFO = 4;
const EV_LISTENER_STATE = 5;
const EV_LISTENER_CONN = 6;
const EV_LISTENER_NAME = 7;
const EV_BROWSER_STATE = 8;
const EV_BROWSER_RESULTS = 9;

const STATE_STARTING = 1;
const STATE_READY = 2;
const STATE_WAITING = 3;
const STATE_FAILED = 4;
const STATE_CANCELLED = 5;

const RECORD_BYTES = 40;
const BATCH = 512;
/**
 * How long one drain runs handlers before it lets the event loop turn, ms. What is left stays on
 * the native side — counted against each connection's high-water mark — until the next one.
 */
const DRAIN_BUDGET_MS = 4;
/** The safety-net poll while anything is open, ms; it also keeps a script that only listens alive. */
const KEEPALIVE_MS = 250;

// ---------------------------------------------------------------------------
// The event pump
// ---------------------------------------------------------------------------

interface Owner {
  event(kind: number, a: number, b: bigint, p: number, length: number): void;
}

const recordBytes = new Uint8Array(RECORD_BYTES * BATCH);
const records = new DataView(recordBytes.buffer);
const owners = new Map<number, Owner>();
let notify: JSCallback | undefined;
let releaseBytes = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;
let draining = false;
let continuation = false;

/** toArrayBuffer with a deallocator: in Bun, not in its typings. */
const wrapBytes = toArrayBuffer as unknown as (
  p: number, offset: number, length: number, context: number, deallocator: number,
) => ArrayBuffer;

/** Events left after a turn's drain ran out of budget: the native side will not signal again. */
let more = false;

/** Start the native side once: the queue, the wake-up callback, the release at exit. */
function ensureInit(): void {
  if (notify) return;
  notify = new JSCallback(() => drain(), { args: [], returns: FFIType.void, threadsafe: true });
  if (isMainThread) {
    // Delivered by the main loop's turns as well as by Bun's loop, so during menus too.
    addTurnSource({
      run(deadline) {
        if (!more && !takePending(Pending.NET)) return false;
        more = false;
        runInTurn(() => {
          drain(Math.max(0.5, deadline - performance.now()), () => {
            more = true;
            requestTurn();
          });
        }, undefined);
        return true;
      },
    });
  }
  lib.br_net_init(notify.ptr);
  releaseBytes = Number(lib.br_dlsym(cstr("br_net_release_bytes")));
  // After this no native thread calls into a VM that is going away.
  process.on("exit", () => lib.br_net_shutdown());
}

/** Route `id`'s events to `owner`, and keep the safety-net poll running while anything is. */
function register(id: number, owner: Owner): void {
  owners.set(id, owner);
  if (keepAlive === undefined) keepAlive = setInterval(drain, KEEPALIVE_MS);
}

/** Stop routing `id`'s events; the last one out stops the safety-net poll. */
function unregister(id: number): void {
  owners.delete(id);
  if (owners.size === 0 && keepAlive !== undefined) {
    clearInterval(keepAlive);
    keepAlive = undefined;
  }
}

/** A C string the native side malloc'd, read and freed. */
function takeString(p: number): string | undefined {
  if (!p) return undefined;
  const s = readCString(p);
  lib.br_free(asPointer(p));
  return s;
}

/** An event whose owner has gone: free what it carried. */
function discard(kind: number, p: number): void {
  if (!p) return;
  if (kind === EV_LISTENER_CONN) {
    lib.br_net_close(asPointer(p));
    lib.br_net_free(asPointer(p));
  } else {
    lib.br_free(asPointer(p));
  }
}

/**
 * Take everything the native side has for JavaScript and hand it to its owners, for up to
 * `budgetMs` ({@link DRAIN_BUDGET_MS} from Bun's loop, what is left of a turn's budget in the main
 * loop); past that, `carryOn` arranges a later task, so timers get a turn. Runs on the thread
 * that uses net — called by a main-loop turn, the wake-up callback (which Bun queues as a task)
 * and the keep-alive timer. A handler that throws is logged; the rest still run. Returns how
 * many events it handled.
 */
function drain(
  budgetMs = DRAIN_BUDGET_MS,
  carryOn: () => void = () => {
    continuation = true;
    setImmediate(drain);
  },
): number {
  if (draining) return 0;
  draining = true;
  continuation = false;
  let total = 0;
  const started = performance.now();
  try {
    for (;;) {
      const n = lib.br_net_poll(recordBytes, BATCH) as number;
      for (let i = 0; i < n; i++) {
        const o = i * RECORD_BYTES;
        const kind = records.getUint32(o, true);
        const id = records.getUint32(o + 4, true);
        const a = records.getInt32(o + 8, true);
        const b = records.getBigUint64(o + 16, true);
        const p = Number(records.getBigUint64(o + 24, true));
        const length = Number(records.getBigUint64(o + 32, true));
        const owner = owners.get(id);
        if (!owner) {
          discard(kind, p);
          continue;
        }
        try {
          owner.event(kind, a, b, p, length);
        } catch (e) {
          console.error("[net] handler failed:", e);
        }
      }
      total += n;
      if (n < BATCH) break;
      if (performance.now() - started > budgetMs) {
        // More is waiting, and no wake-up will come for it: the native side only wakes us when
        // its list goes from empty to not. In a later task — Bun's, or the main loop's next turn.
        carryOn();
        break;
      }
    }
  } finally {
    draining = false;
  }
  return total;
}

/** Call each handler, logging any that throws. */
function fire<A extends unknown[]>(handlers: Iterable<(...args: A) => void>, ...args: A): void {
  for (const h of [...handlers]) {
    try {
      h(...args);
    } catch (e) {
      console.error("[net] handler failed:", e);
    }
  }
}

/** A promise that may be ignored: a rejection nobody awaits is not an unhandled one. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * How many listeners, browsers and connections are alive natively, and how many JavaScript is
 * holding events for — what a soak test watches. `behind` is whether the last drain ran out of
 * its budget and left events for the next one.
 */
export function netStats(): { native: number; owners: number; behind: boolean } {
  return { native: Number(lib.br_net_live()), owners: owners.size, behind: continuation };
}

// ---------------------------------------------------------------------------
// Validation and encoding
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const SERVICE_TYPE = /^_[A-Za-z0-9](?:[A-Za-z0-9-]{0,13}[A-Za-z0-9])?\._tcp\.?$/;

/** `type` without a trailing dot, or a TypeError if it is not `_name._tcp`. Pure. */
function checkType(type: string): string {
  if (typeof type !== "string" || !SERVICE_TYPE.test(type)) {
    throw new TypeError(`net: ${JSON.stringify(type)} is not a Bonjour TCP service type like "_myapp._tcp"`);
  }
  return type.endsWith(".") ? type.slice(0, -1) : type;
}

/** The message limit to use, or a RangeError for one outside 1 B–16 MiB. Pure. */
function checkMax(max: number | undefined): number {
  if (max === undefined) return MAX_MESSAGE_BYTES;
  if (!Number.isInteger(max) || max < 1 || max > MAX_MESSAGE_BYTES) {
    throw new RangeError(`net: maxMessageBytes must be an integer from 1 to ${MAX_MESSAGE_BYTES}, not ${max}`);
  }
  return max;
}

/**
 * A TXT record in DNS wire format: each `key=value` prefixed by its length. Throws on a key that
 * is empty, not printable ASCII or contains `=`, an entry over 255 bytes, or a record over 8900.
 * Pure.
 */
export function encodeTxt(txt: Record<string, string> | undefined): Uint8Array {
  if (!txt) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const [key, value] of Object.entries(txt)) {
    if (key.length === 0 || !/^[\x20-\x3c\x3e-\x7e]+$/.test(key)) {
      throw new TypeError(`net: TXT key ${JSON.stringify(key)} must be printable ASCII without "="`);
    }
    const entry = encoder.encode(`${key}=${String(value)}`);
    if (entry.length > 255) throw new RangeError(`net: TXT entry "${key}" is ${entry.length} bytes; the most is 255`);
    const out = new Uint8Array(entry.length + 1);
    out[0] = entry.length;
    out.set(entry, 1);
    parts.push(out);
    total += out.length;
  }
  if (total > 8900) throw new RangeError(`net: the TXT record is ${total} bytes; the most is 8900`);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return bytes;
}

/** Pre-shared keys packed for net.m: (u32 length, key, u32 length, identity)… little-endian. */
function packKeys(keys: readonly TlsPsk[]): Uint8Array {
  if (keys.length === 0 || keys.length > 16) throw new RangeError("net: give between 1 and 16 pre-shared keys");
  const parts = keys.map(({ psk, identity }) => {
    if (!(psk instanceof Uint8Array) || psk.length < 16 || psk.length > 1024) {
      throw new RangeError("net: a pre-shared key must be a Uint8Array of 16 to 1024 bytes");
    }
    const id = encoder.encode(identity);
    if (typeof identity !== "string" || id.length === 0 || id.length > 128) {
      throw new RangeError("net: a pre-shared key's identity must be 1 to 128 bytes of UTF-8");
    }
    return [psk, id] as const;
  });
  const out = new Uint8Array(parts.reduce((n, [k, id]) => n + 8 + k.length + id.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [k, id] of parts) {
    view.setUint32(at, k.length, true);
    out.set(k, at + 4);
    at += 4 + k.length;
    view.setUint32(at, id.length, true);
    out.set(id, at + 4);
    at += 4 + id.length;
  }
  return out;
}

/** A connection's state, from net.m's number. Pure. */
function stateName(code: number): ConnectionState {
  switch (code) {
    case STATE_STARTING: return "preparing";
    case STATE_READY: return "ready";
    case STATE_WAITING: return "waiting";
    case STATE_FAILED: return "failed";
    case STATE_CANCELLED: return "cancelled";
    default: return "preparing";
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

interface PendingSend {
  bytes: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

/**
 * One message-framed, ordered, reliable connection to a peer. Get one from
 * {@link PeerBrowser.connect}, {@link PeerConnection.connect}, or a listener's
 * {@link PeerListener.onConnection}.
 */
export class PeerConnection {
  /** A number for this connection, unique in the process. */
  readonly id: number;
  #handle: Handle | null;
  #state: ConnectionState = "preparing";
  #error: string | undefined;
  #path: ConnectionPath | undefined;
  #security: ConnectionSecurity | undefined;
  readonly #maxMessage: number;
  readonly #stateHandlers = new Set<(state: ConnectionState, error?: string) => void>();
  readonly #messageHandlers = new Set<(message: Uint8Array) => void>();
  #backlog: Uint8Array[] = [];
  #backlogHead = 0;
  readonly #sends = new Map<number, PendingSend>();
  #nextSequence = 1;
  #buffered = 0;
  #closeAsked = false;
  #flushQueued = false;

  /** @internal Use {@link PeerConnection.connect} or {@link PeerBrowser.connect}. */
  constructor(handle: Handle, maxMessage: number) {
    this.#handle = handle;
    this.#maxMessage = maxMessage;
    this.id = lib.br_net_id(handle) as number;
    register(this.id, { event: (kind, a, b, p, length) => this.#event(kind, a, b, p, length) });
  }

  /**
   * Connect to a peer a browser found — by name, type and domain, resolved afresh — or to a host
   * and port directly (an address on an Ethernet cable, say). Side effect: starts connecting at
   * once; `state` goes `"preparing"` → `"ready"`, or `"waiting"` while there is no route (it keeps
   * trying), or `"failed"`. Throws on bad options; never blocks.
   */
  static connect(target: PeerInfo | { host: string; port: number }, options: ConnectOptions = {}): PeerConnection {
    return open(null, target, options);
  }

  /** The current state. */
  get state(): ConnectionState {
    return this.#state;
  }

  /** Why it failed, is waiting, or was cancelled by the peer — when there is something to say. */
  get error(): string | undefined {
    return this.#error;
  }

  /** The route it took, once ready — refreshed when it changes. For a status line. */
  get path(): ConnectionPath | undefined {
    return this.#path;
  }

  /** What TLS negotiated, on a TLS connection once ready. */
  get security(): ConnectionSecurity | undefined {
    return this.#security;
  }

  /** Bytes handed to {@link send} that Network.framework has not taken yet. */
  get bufferedAmount(): number {
    return this.#buffered;
  }

  /** The largest message this end sends or accepts. */
  get maxMessageBytes(): number {
    return this.#maxMessage;
  }

  /**
   * Call `handler` on every state change, with the reason when there is one. A connection ends
   * `"cancelled"`, always — after `"failed"`, after either end closes it. Returns a function that
   * removes the handler.
   */
  onState(handler: (state: ConnectionState, error?: string) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  /**
   * Call `handler` with each whole message, in the order sent. Messages that arrived before the
   * first handler are kept and delivered to it (in a microtask). The array is the message's own
   * memory, not a copy; keep it as long as you like. Returns a function that removes the handler.
   */
  onMessage(handler: (message: Uint8Array) => void): () => void {
    this.#messageHandlers.add(handler);
    if (this.#backlog.length > this.#backlogHead && !this.#flushQueued) {
      this.#flushQueued = true;
      queueMicrotask(() => {
        this.#flushQueued = false;
        this.#flush();
      });
    }
    return () => this.#messageHandlers.delete(handler);
  }

  /**
   * Resolve once the connection is ready; reject if it fails or is closed first, or after
   * `timeoutMs` (it is left as it is — close it if you are giving up).
   */
  opened(timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.#state === "ready") return resolve();
      if (this.#state === "failed" || this.#state === "cancelled") {
        return reject(new Error(this.#error ?? `the connection is ${this.#state}`));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.onState((state, error) => {
        if (state === "ready") {
          done();
          resolve();
        } else if (state === "failed" || state === "cancelled") {
          done();
          reject(new Error(error ?? `the connection is ${state}`));
        }
      });
      const done = () => {
        off();
        if (timer !== undefined) clearTimeout(timer);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          done();
          reject(new Error(`the connection was not ready in ${timeoutMs} ms (${this.#state}${this.#error ? `: ${this.#error}` : ""})`));
        }, timeoutMs);
      }
    });
  }

  /**
   * Send one message. Returns at once: the bytes are copied (so the array may be reused), and the
   * promise resolves when Network.framework has taken them — await it to keep at most one, or a
   * few, in flight, which is the backpressure. Allowed while `"preparing"`: it goes once ready.
   * Rejects for a message over {@link maxMessageBytes}, on a closed connection, or when the
   * connection fails before sending it; a rejection nobody awaits is not an unhandled one.
   */
  send(message: Uint8Array): Promise<void> {
    if (!(message instanceof Uint8Array)) {
      return quiet(Promise.reject(new TypeError("net: send takes a Uint8Array")));
    }
    if (message.byteLength > this.#maxMessage) {
      return quiet(Promise.reject(new RangeError(
        `net: a message of ${message.byteLength} bytes is over the limit of ${this.#maxMessage}`,
      )));
    }
    if (this.#handle === null || this.#closeAsked || this.#state === "failed" || this.#state === "cancelled") {
      return quiet(Promise.reject(new Error("net: the connection is closed")));
    }
    const sequence = this.#nextSequence++;
    const status = lib.br_net_send(this.#handle, message.byteLength > 0 ? message : null, message.byteLength, BigInt(sequence)) as number;
    if (status !== 0) return quiet(Promise.reject(new Error(`net: couldn't send (${status})`)));
    this.#buffered += message.byteLength;
    return quiet(new Promise<void>((resolve, reject) => {
      this.#sends.set(sequence, { bytes: message.byteLength, resolve, reject });
    }));
  }

  /**
   * Close it. What has been sent goes first, then the peer is told; after two seconds of a peer
   * not reading, it is cut off anyway. `state` becomes `"cancelled"` shortly after, here and at
   * the far end. Idempotent.
   */
  close(): void {
    if (this.#handle === null || this.#closeAsked) return;
    this.#closeAsked = true;
    lib.br_net_close(this.#handle);
  }

  #flush(): void {
    while (this.#backlogHead < this.#backlog.length && this.#messageHandlers.size > 0) {
      const m = this.#backlog[this.#backlogHead]!;
      this.#backlog[this.#backlogHead++] = undefined as unknown as Uint8Array;
      fire(this.#messageHandlers, m);
    }
    if (this.#backlogHead === this.#backlog.length) {
      this.#backlog = [];
      this.#backlogHead = 0;
    }
  }

  #event(kind: number, a: number, b: bigint, p: number, length: number): void {
    switch (kind) {
      case EV_CONN_MESSAGE: {
        const message = length > 0 ? new Uint8Array(wrapBytes(p, 0, length, p, releaseBytes)) : new Uint8Array(0);
        this.#backlog.push(message);
        if (this.#messageHandlers.size > 0 && !this.#flushQueued) this.#flush();
        break;
      }
      case EV_CONN_SENT: {
        const error = takeString(p);
        const pending = this.#sends.get(Number(b));
        if (!pending) break;
        this.#sends.delete(Number(b));
        this.#buffered -= pending.bytes;
        if (a === 0) pending.resolve();
        else pending.reject(new Error(`net: the send failed: ${error ?? "no reason given"}`));
        break;
      }
      case EV_CONN_INFO: {
        const text = takeString(p);
        if (!text) break;
        try {
          const info = JSON.parse(text) as Record<string, unknown>;
          this.#path = {
            interface: info.interface as string | undefined,
            interfaceType: (info.interfaceType as InterfaceType | undefined) ?? "other",
            peerToPeer: !!info.peerToPeer,
            wired: !!info.wired,
            loopback: !!info.loopback,
            local: info.local as string | undefined,
            remote: info.remote as string | undefined,
          };
          this.#security = typeof info.tlsVersion === "string"
            ? { protocol: info.tlsVersion, ciphersuite: Number(info.tlsCiphersuite ?? 0) }
            : undefined;
        } catch {
          // A path we can't read is a path we don't report.
        }
        break;
      }
      case EV_CONN_STATE: {
        const error = takeString(p);
        const state = stateName(a);
        this.#state = state;
        if (error !== undefined || state === "ready") this.#error = error;
        if (state === "cancelled") this.#finish();
        fire(this.#stateHandlers, state, error);
        break;
      }
      default:
        discard(kind, p);
    }
  }

  /** It is over: fail what was still being sent, and let the native side go. */
  #finish(): void {
    for (const pending of this.#sends.values()) pending.reject(new Error("net: the connection closed before the message was sent"));
    this.#sends.clear();
    this.#buffered = 0;
    unregister(this.id);
    if (this.#handle !== null) {
      lib.br_net_free(this.#handle);
      this.#handle = null;
    }
  }
}

/** Start a connection: through a browser's results when there is one. */
function open(browser: Handle | null, target: PeerInfo | { host: string; port: number }, options: ConnectOptions): PeerConnection {
  ensureInit();
  const max = checkMax(options.maxMessageBytes);
  const keys = options.tls ? packKeys([options.tls]) : null;
  const p2p = options.peerToPeer === false ? 0 : 1;
  let handle: Handle | null;
  if ("host" in target) {
    if (typeof target.host !== "string" || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      throw new TypeError("net: connect takes a peer from a browser, or { host, port }");
    }
    handle = lib.br_net_connect(null, null, null, null, cstr(target.host), target.port, p2p, keys, keys?.length ?? 0, max) as Handle | null;
  } else {
    if (!target || typeof target.name !== "string" || typeof target.type !== "string") {
      throw new TypeError("net: connect takes a peer from a browser, or { host, port }");
    }
    handle = lib.br_net_connect(browser, cstr(target.name), cstr(target.type), cstr(target.domain ?? "local."), null, 0, p2p, keys, keys?.length ?? 0, max) as Handle | null;
  }
  if (!handle) throw new Error("net: couldn't start a connection");
  return new PeerConnection(handle, max);
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

/**
 * A service this process offers: a TCP listener advertised with Bonjour, over every interface
 * (AWDL included, unless `peerToPeer: false`). Starts listening when constructed.
 */
export class PeerListener {
  /** A number for this listener, unique in the process. */
  readonly id: number;
  #handle: Handle | null;
  #state: ListenerState = "starting";
  #error: string | undefined;
  #port: number | undefined;
  #name: string;
  readonly #type: string;
  readonly #advertised: boolean;
  readonly #maxMessage: number;
  readonly #connectionHandlers = new Set<(connection: PeerConnection) => void>();
  readonly #stateHandlers = new Set<(state: ListenerState, error?: string) => void>();
  readonly #waiting: PeerConnection[] = [];
  readonly #arriving = new Set<PeerConnection>();
  #closeAsked = false;

  /**
   * Start listening and advertising. Throws on a malformed type, name, TXT record or key; a
   * failure after that (a port in use, say) arrives as state `"failed"`. Side effects: opens a
   * port, registers the service with mDNSResponder — which on macOS 15 and later may ask the
   * person for Local Network permission (see the README).
   */
  constructor(options: ListenerOptions) {
    ensureInit();
    this.#type = checkType(options.type);
    const name = String(options.name ?? "");
    const nameBytes = encoder.encode(name).length;
    if (nameBytes === 0 || nameBytes > 63) throw new RangeError("net: a service name is 1 to 63 bytes of UTF-8");
    this.#name = name;
    this.#maxMessage = checkMax(options.maxMessageBytes);
    const txt = encodeTxt(options.txt);
    const tls = options.tls === undefined ? [] : Array.isArray(options.tls) ? options.tls : [options.tls as TlsPsk];
    const keys = tls.length > 0 ? packKeys(tls) : null;
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`net: ${port} is not a port`);
    const advertise = options.advertise !== false;
    this.#advertised = advertise;
    const handle = lib.br_net_listen(
      advertise ? cstr(this.#type) : null, advertise ? cstr(name) : null, txt.length > 0 ? txt : null, txt.length,
      options.peerToPeer === false ? 0 : 1, keys, keys?.length ?? 0, this.#maxMessage, port,
    ) as Handle | null;
    if (!handle) throw new Error("net: couldn't make a listener");
    this.#handle = handle;
    this.id = lib.br_net_id(handle) as number;
    register(this.id, { event: (kind, a, b, p, length) => this.#event(kind, a, b, p, length) });
  }

  /** The current state. */
  get state(): ListenerState {
    return this.#state;
  }

  /** Why it failed, or what it is waiting for. */
  get error(): string | undefined {
    return this.#error;
  }

  /** The port it listens on, once ready. */
  get port(): number | undefined {
    return this.#port;
  }

  /** The name Bonjour advertises it under: the one asked for, or "Name (2)" if that was taken. */
  get name(): string {
    return this.#name;
  }

  /** The Bonjour type it advertises. */
  get type(): string {
    return this.#type;
  }

  /**
   * Call `handler` with each inbound connection once it is ready to use (a TLS one, once its
   * handshake has passed — one that fails is never handed over). Connections that became ready
   * before the first handler are kept and handed to it. Returns a function that removes it.
   */
  onConnection(handler: (connection: PeerConnection) => void): () => void {
    this.#connectionHandlers.add(handler);
    while (this.#waiting.length > 0 && this.#connectionHandlers.size > 0) {
      fire(this.#connectionHandlers, this.#waiting.shift()!);
    }
    return () => this.#connectionHandlers.delete(handler);
  }

  /** Call `handler` on every state change, with the reason when there is one. Returns a remover. */
  onState(handler: (state: ListenerState, error?: string) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  /**
   * Resolve with the port once listening; reject if it fails or is closed first, or after
   * `timeoutMs`.
   */
  started(timeoutMs?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.#state === "ready") return resolve(this.#port!);
      if (this.#state === "failed" || this.#state === "cancelled") return reject(new Error(this.#error ?? `the listener is ${this.#state}`));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.onState((state, error) => {
        if (state === "ready") {
          done();
          resolve(this.#port!);
        } else if (state === "failed" || state === "cancelled") {
          done();
          reject(new Error(error ?? `the listener is ${state}`));
        }
      });
      const done = () => {
        off();
        if (timer !== undefined) clearTimeout(timer);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          done();
          reject(new Error(`the listener was not ready in ${timeoutMs} ms${this.#error ? `: ${this.#error}` : ""}`));
        }, timeoutMs);
      }
    });
  }

  /**
   * Re-advertise with new metadata. Browsers see it as a change. Throws on a malformed record;
   * does nothing on a listener that is closed or not advertised.
   */
  setTxt(txt: Record<string, string>): void {
    const bytes = encodeTxt(txt);
    if (this.#handle === null || this.#closeAsked || !this.#advertised) return;
    lib.br_net_listener_set_txt(this.#handle, bytes.length > 0 ? bytes : null, bytes.length);
  }

  /**
   * Stop listening and advertising. Connections already handed over stay open; ones still
   * arriving are closed. Idempotent.
   */
  close(): void {
    if (this.#handle === null || this.#closeAsked) return;
    this.#closeAsked = true;
    lib.br_net_close(this.#handle);
    for (const c of this.#arriving) c.close();
  }

  #event(kind: number, a: number, b: bigint, p: number, length: number): void {
    switch (kind) {
      case EV_LISTENER_STATE: {
        const error = takeString(p);
        const code = a;
        const state: ListenerState = code === STATE_READY ? "ready"
          : code === STATE_FAILED ? "failed"
          : code === STATE_CANCELLED ? "cancelled" : "starting";
        if (state === "ready") this.#port = Number(b);
        if (error !== undefined || state === "ready") this.#error = error;
        this.#state = state;
        if (state === "cancelled") {
          unregister(this.id);
          if (this.#handle !== null) {
            lib.br_net_free(this.#handle);
            this.#handle = null;
          }
        }
        fire(this.#stateHandlers, state, error);
        break;
      }
      case EV_LISTENER_CONN: {
        if (!p) break;
        const connection = new PeerConnection(asPointer(p), this.#maxMessage);
        if (this.#closeAsked) {
          connection.close();
          break;
        }
        this.#arriving.add(connection);
        const off = connection.onState((state) => {
          if (state === "ready") {
            off();
            this.#arriving.delete(connection);
            if (this.#connectionHandlers.size > 0) fire(this.#connectionHandlers, connection);
            else this.#waiting.push(connection);
          } else if (state === "failed" || state === "cancelled") {
            off();
            this.#arriving.delete(connection);
          }
        });
        break;
      }
      case EV_LISTENER_NAME: {
        const name = takeString(p);
        if (name) this.#name = name;
        break;
      }
      default:
        discard(kind, p);
    }
  }
}

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

/**
 * Finding services of a type nearby, with their TXT records, over every interface (AWDL included,
 * unless `peerToPeer: false`). Starts browsing when constructed.
 */
export class PeerBrowser {
  /** A number for this browser, unique in the process. */
  readonly id: number;
  #handle: Handle | null;
  #state: BrowserState = "starting";
  #error: string | undefined;
  #peers: readonly PeerInfo[] = Object.freeze([]);
  readonly #options: BrowserOptions;
  readonly #changeHandlers = new Set<(peers: readonly PeerInfo[]) => void>();
  readonly #stateHandlers = new Set<(state: BrowserState, error?: string) => void>();
  #closeAsked = false;

  /**
   * Start browsing. Throws on a malformed type. Side effects: asks mDNSResponder to browse — which
   * on macOS 15 and later may ask the person for Local Network permission (see the README); a
   * refusal shows as state `"waiting"` with the reason.
   */
  constructor(options: BrowserOptions) {
    ensureInit();
    const type = checkType(options.type);
    if (options.tls) packKeys([options.tls]); // validate now, not at the first connect
    checkMax(options.maxMessageBytes);
    this.#options = { ...options, type };
    const handle = lib.br_net_browse(cstr(type), options.peerToPeer === false ? 0 : 1) as Handle | null;
    if (!handle) throw new Error("net: couldn't make a browser");
    this.#handle = handle;
    this.id = lib.br_net_id(handle) as number;
    register(this.id, { event: (kind, a, b, p, length) => this.#event(kind, a, b, p, length) });
  }

  /** The current state. */
  get state(): BrowserState {
    return this.#state;
  }

  /** Why it failed, or what it is waiting for. */
  get error(): string | undefined {
    return this.#error;
  }

  /** Every peer found now, sorted by name. */
  get peers(): readonly PeerInfo[] {
    return this.#peers;
  }

  /** Call `handler` with the full list of peers on every change. Returns a remover. */
  onChange(handler: (peers: readonly PeerInfo[]) => void): () => void {
    this.#changeHandlers.add(handler);
    return () => this.#changeHandlers.delete(handler);
  }

  /** Call `handler` on every state change, with the reason when there is one. Returns a remover. */
  onState(handler: (state: BrowserState, error?: string) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  /**
   * Connect to `peer`, with this browser's `tls`, `peerToPeer` and `maxMessageBytes` unless
   * `options` says otherwise. The peer is resolved by name when the connection starts, through
   * this browser's latest result for it if it has one (which knows the interfaces it was seen on).
   */
  connect(peer: PeerInfo, options: ConnectOptions = {}): PeerConnection {
    const merged: ConnectOptions = {
      tls: options.tls ?? this.#options.tls,
      peerToPeer: options.peerToPeer ?? this.#options.peerToPeer,
      maxMessageBytes: options.maxMessageBytes ?? this.#options.maxMessageBytes,
    };
    return open(this.#closeAsked ? null : this.#handle, peer, merged);
  }

  /** Stop browsing. Connections made from it are not affected. Idempotent. */
  close(): void {
    if (this.#handle === null || this.#closeAsked) return;
    this.#closeAsked = true;
    lib.br_net_close(this.#handle);
  }

  #event(kind: number, a: number, _b: bigint, p: number, _length: number): void {
    switch (kind) {
      case EV_BROWSER_STATE: {
        const error = takeString(p);
        const state: BrowserState = a === STATE_READY ? "ready"
          : a === STATE_WAITING ? "waiting"
          : a === STATE_FAILED ? "failed"
          : a === STATE_CANCELLED ? "cancelled" : "starting";
        this.#state = state;
        if (error !== undefined || state === "ready") this.#error = error;
        if (state === "cancelled") {
          unregister(this.id);
          if (this.#handle !== null) {
            lib.br_net_free(this.#handle);
            this.#handle = null;
          }
        }
        fire(this.#stateHandlers, state, error);
        break;
      }
      case EV_BROWSER_RESULTS: {
        const text = takeString(p);
        if (!text) break;
        let list: PeerInfo[];
        try {
          list = (JSON.parse(text) as PeerInfo[]).map((peer) => Object.freeze({
            name: peer.name,
            type: peer.type,
            domain: peer.domain,
            txt: Object.freeze({ ...peer.txt }),
            interfaces: Object.freeze(peer.interfaces.map((i) => Object.freeze({ ...i }))),
          }));
        } catch {
          break;
        }
        this.#peers = Object.freeze(list);
        fire(this.#changeHandlers, this.#peers);
        break;
      }
      default:
        discard(kind, p);
    }
  }
}
