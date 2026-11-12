// Threads: workers compiled into the app, with a channel to and from the main thread that keeps
// moving while AppKit holds the main thread — an open menu, a live resize, a slider drag.
//
//   // main.ts
//   const show = spawnThread(new URL("./show.ts", import.meta.url), { name: "show" });
//   show.channel.send({ kind: "load", path });          // to the thread
//   show.channel.onMessage((m) => …);                   // from it: arrives during a menu
//   const safety = show.cell(Safety, "write");          // a shared cell, written here
//
//   // show.ts
//   import { parent } from "bunkit/thread";
//   parent!.channel.onMessage((m) => …);
//   const safety = parent!.cell(Safety, "read");        // read every frame of the show's clock
//
// docs/main-loop/spec.md §7 is the design. A thread's own Bun loop is untouched by anything AppKit
// does, so work that must not stop — deadlines, networking, anything a person is waiting on —
// belongs on one.
//
// The channel is two single-producer, single-consumer rings in SharedArrayBuffers, one each way.
// A message is framed (length, tag, bytes) into the ring and published with an atomic store of
// the ring's tail. Thread → main, the producer then signals BunKit's main loop — its run-loop
// source, so the message is delivered in a main-loop turn, inside any nested loop AppKit is
// running — but only when the main thread has armed the ring's idle flag: a busy stream costs one
// signal per turn, not one per message. Main → thread, the thread waits with Atomics.waitAsync,
// which keeps its own loop running. Not postMessage: on the main thread that is delivered by Bun's
// loop, which is stopped while AppKit nests.
//
// A payload larger than half the ring goes through the channel's arena, a second ring of bytes
// that grows to fit, and the ring carries a handle to it.

import { dlopen, FFIType } from "bun:ffi";
import { deserialize, serialize } from "bun:jsc";
import { isMainThread, workerData } from "node:worker_threads";

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

// Control words, Int32 indices. Head and tail sit on cache lines of their own.
const HEAD = 0;
const TAIL = 16;
const IDLE = 32; // the consumer is waiting and wants a signal
const CLOSED = 33; // the producer will send nothing more
const DROPPED = 34;
const SIGNALS = 35; // signals the producer sent
const WAITING = 36; // the producer is waiting for room
const SENT = 37;
const ARENA_HEAD = 48;
const ARENA_TAIL = 56;
const ARENA_CAP = 57;
const CONTROL_WORDS = 64;

const HEADER = 8; // u32 length, u8 tag, u8 flags, u16 unused
const FLAG_ARENA = 1;
const align8 = (n: number) => (n + 7) & ~7;

/** What a channel does when the ring is full. */
export type Backpressure = "fail" | "drop-oldest" | "wait";

export interface RingBuffers {
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
  arena: SharedArrayBuffer;
}

function makeRing(bytes: number, arenaBytes: number): RingBuffers {
  // Powers of two, so positions — u32 counters that wrap — map onto offsets the same way after
  // wrapping as before.
  const cap = 1 << Math.ceil(Math.log2(Math.max(4096, bytes)));
  const arenaCap = 1 << Math.ceil(Math.log2(Math.max(4096, arenaBytes)));
  const control = new SharedArrayBuffer(CONTROL_WORDS * 4);
  const arena = new SharedArrayBuffer(arenaCap, { maxByteLength: 1 << 30 } as any);
  const c = new Int32Array(control);
  c[ARENA_CAP] = arenaCap;
  c[IDLE] = 1; // armed from the start: the first message signals
  return { control, data: new SharedArrayBuffer(cap), arena };
}

/** One direction of a channel: a ring of framed messages, and an arena for large ones. */
class Ring {
  readonly c: Int32Array;
  readonly data: Uint8Array;
  readonly view: DataView;
  readonly cap: number;
  readonly mask: number;
  readonly arenaBuffer: SharedArrayBuffer & { grow(n: number): void; maxByteLength: number };

  constructor(readonly buffers: RingBuffers) {
    this.c = new Int32Array(buffers.control);
    this.data = new Uint8Array(buffers.data);
    this.view = new DataView(buffers.data);
    this.cap = this.data.length;
    this.mask = this.cap - 1;
    this.arenaBuffer = buffers.arena as any;
  }

  get pending(): boolean {
    return Atomics.load(this.c, TAIL) !== Atomics.load(this.c, HEAD);
  }

  #free(): number {
    return this.cap - ((Atomics.load(this.c, TAIL) - Atomics.load(this.c, HEAD)) >>> 0);
  }

  #copyIn(target: Uint8Array, mask: number, pos: number, bytes: Uint8Array): void {
    const offset = pos & mask;
    const first = Math.min(bytes.length, target.length - offset);
    target.set(bytes.subarray(0, first), offset);
    if (first < bytes.length) target.set(bytes.subarray(first), 0);
  }

  #copyOut(source: Uint8Array, mask: number, pos: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    const offset = pos & mask;
    const first = Math.min(length, source.length - offset);
    out.set(source.subarray(offset, offset + first), 0);
    if (first < length) out.set(source.subarray(0, length - first), first);
    return out;
  }

  /**
   * Make `need` bytes of room in the ring (and `arenaNeed` in the arena), as `mode` says.
   * False when there is none to be had: the message is not sent.
   */
  #room(need: number, arenaNeed: number, mode: Backpressure, waitMs: number): boolean {
    const deadline = mode === "wait" ? performance.now() + waitMs : 0;
    for (;;) {
      if (this.#free() >= need && (arenaNeed === 0 || this.#arenaRoom(arenaNeed))) return true;
      if (mode === "drop-oldest" && arenaNeed === 0 && this.#dropOldest()) continue;
      if (mode !== "wait") return false;
      const left = deadline - performance.now();
      if (left <= 0) return false;
      const head = Atomics.load(this.c, HEAD);
      Atomics.store(this.c, WAITING, 1);
      if (this.#free() >= need && (arenaNeed === 0 || this.#arenaRoom(arenaNeed))) continue;
      Atomics.wait(this.c, HEAD, head, Math.min(left, 50));
    }
  }

  /**
   * Drop the oldest message to make room — for telemetry, where the latest matters. The consumer
   * claims a message with a compare-and-swap of the head after copying it, so a message dropped
   * from under it is one it discards. A message in the arena is never dropped this way.
   */
  #dropOldest(): boolean {
    const head = Atomics.load(this.c, HEAD);
    if (head === Atomics.load(this.c, TAIL)) return false;
    const at = head & this.mask;
    const length = this.view.getUint32(at, true);
    const flags = this.data[at + 5]!;
    if (flags & FLAG_ARENA) return false;
    const size = HEADER + align8(length);
    if (Atomics.compareExchange(this.c, HEAD, head, (head + size) | 0) === head) {
      Atomics.add(this.c, DROPPED, 1);
    }
    return true;
  }

  #arenaRoom(need: number): boolean {
    const head = Atomics.load(this.c, ARENA_HEAD);
    const tail = Atomics.load(this.c, ARENA_TAIL);
    let cap = Atomics.load(this.c, ARENA_CAP);
    if (need > cap) {
      // Grown only while empty, so no message in flight is mapped by the old size.
      if (head !== tail) return false;
      const grown = 1 << Math.ceil(Math.log2(need));
      if (grown > this.arenaBuffer.maxByteLength) return false;
      if (this.arenaBuffer.byteLength < grown) this.arenaBuffer.grow(grown);
      Atomics.store(this.c, ARENA_CAP, grown);
      cap = grown;
    }
    return cap - ((tail - head) >>> 0) >= need;
  }

  /** Write one message. False if it was not sent: the ring stayed full, or it is closed. */
  write(tag: number, bytes: Uint8Array, mode: Backpressure, waitMs: number): boolean {
    if (Atomics.load(this.c, CLOSED)) return false;
    const large = HEADER + align8(bytes.length) > this.cap >> 1;
    const need = large ? HEADER + 8 : HEADER + align8(bytes.length);
    const arenaNeed = large ? align8(bytes.length) : 0;
    if (!this.#room(need, arenaNeed, mode, waitMs)) {
      Atomics.add(this.c, DROPPED, 1);
      return false;
    }
    const tail = Atomics.load(this.c, TAIL);
    const at = tail & this.mask;
    this.view.setUint32(at, bytes.length, true);
    this.data[at + 4] = tag;
    this.data[at + 5] = large ? FLAG_ARENA : 0;
    if (large) {
      const arenaTail = Atomics.load(this.c, ARENA_TAIL);
      const cap = Atomics.load(this.c, ARENA_CAP);
      this.#copyIn(new Uint8Array(this.arenaBuffer, 0, cap), cap - 1, arenaTail, bytes);
      Atomics.store(this.c, ARENA_TAIL, (arenaTail + arenaNeed) | 0);
      this.view.setUint32((tail + HEADER) & this.mask, arenaTail >>> 0, true);
    } else {
      this.#copyIn(this.data, this.mask, tail + HEADER, bytes);
    }
    // Publish: everything above happens before the consumer can see the new tail.
    Atomics.store(this.c, TAIL, (tail + need) | 0);
    Atomics.add(this.c, SENT, 1);
    return true;
  }

  /** Take the oldest message, or undefined. */
  read(): { tag: number; bytes: Uint8Array } | undefined {
    for (;;) {
      const head = Atomics.load(this.c, HEAD);
      if (head === Atomics.load(this.c, TAIL)) return undefined;
      const at = head & this.mask;
      const length = this.view.getUint32(at, true);
      const tag = this.data[at + 4]!;
      const flags = this.data[at + 5]!;
      if (flags & FLAG_ARENA) {
        const size = HEADER + 8;
        const arenaPos = this.view.getUint32((head + HEADER) & this.mask, true);
        // Claimed first: a message in the arena is never dropped, so this always holds.
        if (Atomics.compareExchange(this.c, HEAD, head, (head + size) | 0) !== head) continue;
        const cap = Atomics.load(this.c, ARENA_CAP);
        const bytes = this.#copyOut(new Uint8Array(this.arenaBuffer, 0, cap), cap - 1, arenaPos, length);
        Atomics.store(this.c, ARENA_HEAD, (arenaPos + align8(length)) | 0);
        this.#released();
        return { tag, bytes };
      }
      const size = HEADER + align8(length);
      if (size > this.cap) continue; // torn: dropped and overwritten while we looked
      const bytes = this.#copyOut(this.data, this.mask, head + HEADER, length);
      // Copied, then claimed: if the producer dropped it meanwhile, what was copied is discarded.
      if (Atomics.compareExchange(this.c, HEAD, head, (head + size) | 0) !== head) continue;
      this.#released();
      return { tag, bytes };
    }
  }

  #released(): void {
    if (Atomics.load(this.c, WAITING) && Atomics.compareExchange(this.c, WAITING, 1, 0) === 1) {
      Atomics.notify(this.c, HEAD);
    }
  }

  /** Producer: after publishing, whether the consumer asked to be told. Clears its request. */
  takeIdle(): boolean {
    if (Atomics.load(this.c, IDLE) !== 1) return false;
    if (Atomics.compareExchange(this.c, IDLE, 1, 0) !== 1) return false;
    Atomics.add(this.c, SIGNALS, 1);
    return true;
  }

  /** Consumer: ask to be told about the next message. False if one is already here. */
  armIdle(): boolean {
    Atomics.store(this.c, IDLE, 1);
    if (!this.pending) return true;
    Atomics.store(this.c, IDLE, 0);
    return false;
  }

  close(): void {
    Atomics.store(this.c, CLOSED, 1);
  }

  get closed(): boolean {
    return Atomics.load(this.c, CLOSED) !== 0;
  }

  get counters(): { sent: number; dropped: number; signals: number } {
    return {
      sent: Atomics.load(this.c, SENT),
      dropped: Atomics.load(this.c, DROPPED),
      signals: Atomics.load(this.c, SIGNALS),
    };
  }
}

// ---------------------------------------------------------------------------
// The codec: structured-clone values, with fast paths for strings and typed arrays
// ---------------------------------------------------------------------------

const T_CLONE = 1;
const T_STRING = 2;
const T_BUFFER = 3;
const T_CONTROL = 15;
const TYPED: Array<new (b: ArrayBuffer, o: number, n: number) => ArrayBufferView> = [
  Uint8Array, Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
] as any;
const T_TYPED = 16; // + index into TYPED

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(value: unknown): { tag: number; bytes: Uint8Array } {
  if (typeof value === "string") return { tag: T_STRING, bytes: encoder.encode(value) };
  if (value instanceof ArrayBuffer) return { tag: T_BUFFER, bytes: new Uint8Array(value) };
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const index = TYPED.findIndex((T) => value.constructor === T);
    if (index >= 0) {
      return { tag: T_TYPED + index, bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
    }
  }
  return { tag: T_CLONE, bytes: new Uint8Array(serialize(value) as ArrayBufferLike) };
}

function decode(tag: number, bytes: Uint8Array): unknown {
  if (tag === T_STRING) return decoder.decode(bytes);
  if (tag === T_BUFFER) return bytes.buffer;
  if (tag >= T_TYPED && tag < T_TYPED + TYPED.length) {
    const T = TYPED[tag - T_TYPED]! as any;
    return new T(bytes.buffer, 0, bytes.byteLength / T.BYTES_PER_ELEMENT);
  }
  if (tag === T_CONTROL) return JSON.parse(decoder.decode(bytes));
  return deserialize(bytes);
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

export interface ChannelOptions {
  /** What a send does when the ring is full. Default "fail". "wait" waits only off the main thread. */
  backpressure?: Backpressure;
  /** How long a "wait" send waits for room, ms. Default 1000. */
  waitMs?: number;
}

export interface ChannelStats {
  sent: number;
  received: number;
  /** Messages dropped: by "drop-oldest", or refused by "fail" and "wait". */
  dropped: number;
  /** Times this end woke the other. A busy stream costs one per turn, not one per message. */
  signals: number;
  /** Times the other end woke this one. */
  wakeups: number;
  /** What the other end has sent, and how many of its messages it dropped. */
  peerSent: number;
  peerDropped: number;
}

type Handler = (message: any) => void;

/** One end of a channel: send to the other end, and hear from it. */
export class Channel {
  readonly #out: Ring;
  readonly #in: Ring;
  readonly #mode: Backpressure;
  readonly #waitMs: number;
  readonly #wake: () => void;
  readonly #handlers = new Set<Handler>();
  readonly #onListen: (listening: boolean) => void;
  #received = 0;
  /** Control messages: errors, exits and the like, for the side that owns this end. */
  onControl: ((message: any) => void) | undefined;

  /** @internal */
  constructor(
    out: Ring,
    inbound: Ring,
    wake: () => void,
    options: ChannelOptions,
    onListen: (listening: boolean) => void = () => {},
  ) {
    this.#out = out;
    this.#in = inbound;
    this.#wake = wake;
    this.#mode = options.backpressure ?? "fail";
    this.#waitMs = options.waitMs ?? 1000;
    this.#onListen = onListen;
    if (this.#mode === "wait" && isMainThread) {
      // The main thread never blocks: AppKit is waiting on it.
      this.#mode = "fail";
    }
  }

  /**
   * Send `message`: any structured-clone value; strings, ArrayBuffers and typed arrays go as
   * their bytes. Returns false when it was not sent — the ring was full (backpressure "fail", or
   * "wait" timing out), or the channel is closed.
   */
  send(message: unknown): boolean {
    const { tag, bytes } = encode(message);
    return this.#write(tag, bytes);
  }

  /** @internal */
  sendControl(message: object): boolean {
    return this.#write(T_CONTROL, encoder.encode(JSON.stringify(message)));
  }

  #write(tag: number, bytes: Uint8Array): boolean {
    if (!this.#out.write(tag, bytes, this.#mode, this.#waitMs)) return false;
    if (this.#out.takeIdle()) this.#wake();
    return true;
  }

  /** Hear every message from the other end, in order. */
  onMessage(fn: Handler): { dispose(): void; [Symbol.dispose](): void } {
    this.#handlers.add(fn);
    if (this.#handlers.size === 1) this.#onListen(true);
    const stop = () => {
      if (this.#handlers.delete(fn) && this.#handlers.size === 0) this.#onListen(false);
    };
    return { dispose: stop, [Symbol.dispose]: stop };
  }

  /** No more messages from this end. The other end still receives what was sent before. */
  close(): void {
    this.#out.close();
    if (this.#out.takeIdle()) this.#wake();
  }

  get stats(): ChannelStats {
    const out = this.#out.counters;
    const inbound = this.#in.counters;
    return {
      sent: out.sent,
      received: this.#received,
      dropped: out.dropped,
      signals: out.signals,
      wakeups: inbound.signals,
      peerSent: inbound.sent,
      peerDropped: inbound.dropped,
    };
  }

  /** @internal Is anything waiting to be read? */
  get pending(): boolean {
    return this.#in.pending;
  }

  /** @internal The other end closed its side. */
  get peerClosed(): boolean {
    return this.#in.closed;
  }

  /**
   * @internal Deliver what has arrived, through `run` (a main-loop task on the main thread).
   * Stops at `deadline`; returns whether it delivered anything.
   */
  drain(deadline: number, run: (fn: Handler, message: unknown) => void): boolean {
    let any = false;
    for (;;) {
      const m = this.#in.read();
      if (!m) break;
      any = true;
      const value = decode(m.tag, m.bytes);
      if (m.tag === T_CONTROL) {
        this.onControl?.(value);
      } else {
        this.#received++;
        for (const h of [...this.#handlers]) run(h, value);
      }
      if (performance.now() >= deadline) break;
    }
    return any;
  }

  /** @internal Ask the other end to wake us for the next message. False if one is here already. */
  armIdle(): boolean {
    return this.#in.armIdle();
  }

  /** @internal The words the receiver waits on (thread side). */
  get inboundControl(): Int32Array {
    return this.#in.c;
  }
}

// ---------------------------------------------------------------------------
// Shared cells (§7.4)
// ---------------------------------------------------------------------------

/** A cell's fields: numbers and booleans, each stored as a 64-bit float. */
export type CellValue = Record<string, number | boolean>;

export interface CellLayout<T extends CellValue> {
  readonly name: string;
  readonly fields: readonly (keyof T & string)[];
  readonly defaults: Readonly<T>;
}

/**
 * Describe a shared cell: its name (the same on both sides) and its fields, with defaults.
 *
 *   const Safety = cellLayout("safety", { live: true, haze: 1, masters: 1 });
 */
export function cellLayout<T extends CellValue>(name: string, defaults: T): CellLayout<Widen<T>> {
  return {
    name,
    fields: Object.keys(defaults) as (keyof T & string)[],
    defaults: { ...defaults } as unknown as Widen<T>,
  };
}

/** `{ on: false }` describes a boolean field, not one that is always false. */
type Widen<T> = { [K in keyof T]: T[K] extends boolean ? boolean : number };

const CELL_HEADER = 8; // an Int32 sequence word, padded to the first float

/**
 * A fixed layout over shared memory with one writer, under a seqlock: the version is odd while
 * being written, and a reader retries until it reads the same even version either side of the
 * fields. The latest value wins: no messages, no latency beyond the reader's next read.
 */
class Cell<T extends CellValue> {
  #seq: Int32Array | undefined;
  #fields: Float64Array | undefined;
  #local: T;
  readonly layout: CellLayout<T>;

  constructor(layout: CellLayout<T>, buffer?: SharedArrayBuffer) {
    this.layout = layout;
    this.#local = { ...layout.defaults };
    if (buffer) this.attach(buffer);
  }

  /** @internal */
  attach(buffer: SharedArrayBuffer): void {
    this.#seq = new Int32Array(buffer, 0, 1);
    this.#fields = new Float64Array(buffer, CELL_HEADER, this.layout.fields.length);
  }

  get attached(): boolean {
    return this.#seq !== undefined;
  }

  /** The value now. The layout's defaults until the cell's memory has arrived (a thread's end). */
  read(): T {
    return this.readInto({ ...this.layout.defaults });
  }

  /** The value now, into `out`: no allocation, for a reader that reads every frame. */
  readInto(out: T): T {
    const seq = this.#seq;
    const fields = this.#fields;
    if (!seq || !fields) return Object.assign(out, this.#local);
    const names = this.layout.fields;
    const defaults = this.layout.defaults as Record<string, number | boolean>;
    for (let spins = 0; ; spins++) {
      const before = Atomics.load(seq, 0);
      if (before & 1) continue; // being written
      for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        const v = fields[i]!;
        (out as any)[name] = typeof defaults[name] === "boolean" ? v !== 0 : v;
      }
      // A read-modify-write, not a load: it orders the field reads above before it on every
      // processor, which a plain acquire load does not.
      if (Atomics.compareExchange(seq, 0, before, before) === before) return out;
    }
  }

  /** How many writes so far: compare two reads to see whether anything changed. */
  get version(): number {
    return this.#seq ? Atomics.load(this.#seq, 0) >>> 1 : 0;
  }

  /** @internal */
  write(value: Partial<T>): void {
    const seq = this.#seq;
    const fields = this.#fields;
    Object.assign(this.#local, value);
    if (!seq || !fields) return;
    Atomics.add(seq, 0, 1); // odd: being written
    const names = this.layout.fields;
    for (let i = 0; i < names.length; i++) {
      const v = (this.#local as any)[names[i]!];
      fields[i] = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
    }
    Atomics.add(seq, 0, 1); // even: done
  }

  /** @internal Whatever was written before the memory arrived. */
  get local(): T {
    return this.#local;
  }
}

/** The reading end of a shared cell. */
export interface CellReader<T extends CellValue> {
  readonly layout: CellLayout<T>;
  /** False until the cell's memory has arrived from the main thread (a thread's end only). */
  readonly attached: boolean;
  readonly version: number;
  read(): T;
  readInto(out: T): T;
}

/** The writing end of a shared cell: there is one. */
export interface CellWriter<T extends CellValue> extends CellReader<T> {
  /** Write some or all fields; the rest keep their values. */
  write(value: Partial<T>): void;
}

function cellBytes(layout: CellLayout<CellValue>): number {
  return CELL_HEADER + layout.fields.length * 8;
}

// ---------------------------------------------------------------------------
// The main thread's end
// ---------------------------------------------------------------------------

export interface SpawnOptions extends ChannelOptions {
  /** For messages and errors. Default: the file's name. */
  name?: string;
  /** Each ring's size, bytes. Default 1 MiB. Messages over half of it go through the arena. */
  ringBytes?: number;
  /** The arena's starting size, bytes; it grows to fit the largest message. Default 4 MiB. */
  arenaBytes?: number;
}

/** An uncaught error in a thread, as it reached the main thread. */
export interface ThreadError {
  thread: string;
  name: string;
  message: string;
  stack: string;
}

interface CellMessage {
  __bunkitCell: { name: string; buffer: SharedArrayBuffer; mode: "read" | "write" };
}

const threads = new Set<Thread>();

/** A thread started with {@link spawnThread}. */
export class Thread {
  readonly name: string;
  readonly worker: Worker;
  /** Send to the thread, and hear from it. Messages from it arrive during menus and resizes. */
  readonly channel: Channel;
  readonly #errorHandlers = new Set<(e: ThreadError) => void>();
  readonly #exitHandlers = new Set<(code: number) => void>();
  readonly #cells = new Map<string, { cell: Cell<any>; mode: "read" | "write" }>();
  #exited = false;
  #exitCode = 0;
  #closing: Promise<void> | undefined;

  /** @internal */
  constructor(url: URL | string, options: SpawnOptions, main: typeof import("./mainloop.ts")) {
    const href = typeof url === "string" ? url : url.href;
    this.name = options.name ?? href.split("/").pop()!.replace(/\.[jt]s$/, "");
    const ringBytes = options.ringBytes ?? 1 << 20;
    const arenaBytes = options.arenaBytes ?? 4 << 20;
    const toThread = makeRing(ringBytes, arenaBytes);
    const fromThread = makeRing(ringBytes, arenaBytes);
    const down = new Ring(toThread);
    const up = new Ring(fromThread);
    this.channel = new Channel(down, up, () => Atomics.notify(down.c, IDLE), options);
    this.channel.onControl = (m) => this.#control(m);
    this.worker = new Worker(href, {
      workerData: {
        bunkit: {
          name: this.name,
          lib: main.libraryPath(),
          toThread,
          fromThread,
          backpressure: options.backpressure ?? "fail",
          waitMs: options.waitMs ?? 1000,
        },
      },
    } as any);
    // A thread that dies before BunKit's end of it runs — a syntax error, a failed import —
    // reaches here through Bun's loop instead.
    this.worker.addEventListener("error", (e: ErrorEvent) => {
      e.preventDefault?.();
      this.#error({ name: "Error", message: e.message, stack: String((e as any).error?.stack ?? e.message) });
    });
    this.worker.addEventListener("close", (e: any) => this.#exit(Number(e?.code ?? 0)));
    threads.add(this);
  }

  #control(m: any): void {
    if (m?.k === "error") this.#error(m);
    else if (m?.k === "exit") this.#exit(Number(m.code ?? 0));
  }

  #error(m: { name?: string; message?: string; stack?: string }): void {
    const error: ThreadError = {
      thread: this.name,
      name: String(m.name ?? "Error"),
      message: String(m.message ?? ""),
      stack: String(m.stack ?? m.message ?? ""),
    };
    if (this.#errorHandlers.size === 0) {
      console.error(`[bunkit] thread "${this.name}" failed:\n${error.stack}`);
      return;
    }
    for (const h of [...this.#errorHandlers]) {
      try {
        h(error);
      } catch (e) {
        console.error("[bunkit] a thread error handler threw:", e);
      }
    }
  }

  #exit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#exitCode = code;
    for (const h of [...this.#exitHandlers]) {
      try {
        h(code);
      } catch (e) {
        console.error("[bunkit] a thread exit handler threw:", e);
      }
    }
  }

  /** Hear an uncaught error in the thread, with its stack. The thread is not restarted. */
  onError(fn: (error: ThreadError) => void): { dispose(): void; [Symbol.dispose](): void } {
    this.#errorHandlers.add(fn);
    const stop = () => void this.#errorHandlers.delete(fn);
    return { dispose: stop, [Symbol.dispose]: stop };
  }

  /** Hear the thread end, with its exit code. */
  onExit(fn: (code: number) => void): { dispose(): void; [Symbol.dispose](): void } {
    this.#exitHandlers.add(fn);
    const stop = () => void this.#exitHandlers.delete(fn);
    return { dispose: stop, [Symbol.dispose]: stop };
  }

  get exited(): boolean {
    return this.#exited;
  }

  get exitCode(): number {
    return this.#exitCode;
  }

  /**
   * A shared cell between this thread and the main one, by its layout's name. One side writes it,
   * the other reads it. The main thread's call makes the memory; the thread's `parent.cell` with
   * the same layout attaches to it.
   */
  cell<T extends CellValue>(layout: CellLayout<T>, mode: "write"): CellWriter<T>;
  cell<T extends CellValue>(layout: CellLayout<T>, mode: "read"): CellReader<T>;
  cell<T extends CellValue>(layout: CellLayout<T>, mode: "read" | "write"): CellReader<T> | CellWriter<T> {
    let entry = this.#cells.get(layout.name);
    if (entry && entry.mode !== mode) {
      throw new Error(`cell "${layout.name}" is already this side's to ${entry.mode}`);
    }
    if (!entry) {
      const buffer = new SharedArrayBuffer(cellBytes(layout));
      const cell = new Cell(layout, buffer);
      cell.write({}); // the defaults, so a reader on either side starts from them
      entry = { cell, mode };
      this.#cells.set(layout.name, entry);
      const message: CellMessage = { __bunkitCell: { name: layout.name, buffer, mode } };
      // postMessage is fine here: it is the thread's loop that delivers it, and that never stops.
      this.worker.postMessage(message);
    }
    return cellHandle(entry.cell as Cell<T>, mode);
  }

  /**
   * Ask the thread to finish, and end it: its `parent.onClose` handlers run, then it exits. A
   * thread still running after `deadlineMs` is terminated, and one that will not stop even then
   * is abandoned: this never waits for ever.
   */
  terminate(deadlineMs = 1000): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (!this.#exited) {
        this.channel.sendControl({ k: "close" });
        const until = performance.now() + deadlineMs;
        while (!this.#exited && performance.now() < until) await Bun.sleep(5);
        if (!this.#exited) this.worker.terminate();
      }
      threads.delete(this);
    })();
    return this.#closing;
  }
}

function cellHandle<T extends CellValue>(cell: Cell<T>, mode: "read" | "write"): CellReader<T> | CellWriter<T> {
  const reader: CellReader<T> = {
    layout: cell.layout,
    get attached() {
      return cell.attached;
    },
    get version() {
      return cell.version;
    },
    read: () => cell.read(),
    readInto: (out: T) => cell.readInto(out),
  };
  if (mode === "read") return reader;
  return Object.assign(reader, { write: (v: Partial<T>) => cell.write(v) }) as CellWriter<T>;
}

let mainLoopModule: typeof import("./mainloop.ts") | undefined;
let removeSource: (() => void) | undefined;

function mainSide(): typeof import("./mainloop.ts") {
  if (!isMainThread) throw new Error("spawnThread: threads are started from the main thread");
  if (!mainLoopModule) {
    // Loaded here, not at the top: a thread imports this module too, and must not load the
    // main loop (and AppKit with it) into itself.
    mainLoopModule = require("./mainloop.ts") as typeof import("./mainloop.ts");
    const main = mainLoopModule;
    removeSource = main.addTurnSource({
      run(deadline) {
        let ran = false;
        for (const t of [...threads]) {
          ran = t.channel.drain(deadline, main.runInTurn) || ran;
          if (performance.now() >= deadline) {
            // More may be waiting: the next turn takes it.
            if (t.channel.pending) main.requestTurn();
            continue;
          }
          // Asked to be woken for the next message; if one arrived meanwhile, take it next.
          if (!t.channel.armIdle()) main.requestTurn();
        }
        return ran;
      },
    });
    main.onShutdown(async () => {
      await Promise.all([...threads].map((t) => t.terminate(SHUTDOWN_DEADLINE_MS)));
    });
  }
  return mainLoopModule;
}

/** How long quitting waits for every thread to finish, all together, ms. */
const SHUTDOWN_DEADLINE_MS = 1000;

/**
 * Start a thread: a worker, compiled into the app by the bundler's `workers` option, with a
 * channel to and from it. `url` resolves the same from source and from the bundle:
 * `new URL("./show.ts", import.meta.url)`.
 *
 * Threads are ended on quit, after the quit handlers, against one deadline: a stuck thread is
 * abandoned, never waited for forever. `bun:ffi` in a thread opens the same libraries into the
 * same process; whether one may be called from two threads at once is that library's contract.
 */
export function spawnThread(url: URL | string, options: SpawnOptions = {}): Thread {
  const main = mainSide();
  main.ensureMainLoop();
  return new Thread(url, options, main);
}

/** Every thread started and not yet ended. */
export function liveThreads(): Thread[] {
  return [...threads];
}

// ---------------------------------------------------------------------------
// A thread's end
// ---------------------------------------------------------------------------

/** Inside a thread started with {@link spawnThread}: its end of the channel, and its cells. */
export interface Parent {
  /** The thread's name, as the main thread gave it. */
  readonly name: string;
  /** Send to the main thread, and hear from it. */
  readonly channel: Channel;
  /** Attach to a cell the main thread makes with the same layout (`thread.cell`). */
  cell<T extends CellValue>(layout: CellLayout<T>, mode: "write"): CellWriter<T>;
  cell<T extends CellValue>(layout: CellLayout<T>, mode: "read"): CellReader<T>;
  /** Run `fn` when the main thread asks this thread to finish (quitting, or `terminate`). */
  onClose(fn: () => void | Promise<void>): void;
}

function startThreadSide(data: any): Parent {
  const symbols = dlopen(data.lib, { br_main_signal: { args: [], returns: FFIType.void } }).symbols;
  const up = new Ring(data.fromThread);
  const down = new Ring(data.toThread);
  const channel = new Channel(up, down, () => symbols.br_main_signal(), {
    backpressure: data.backpressure,
    waitMs: data.waitMs,
  }, (listening) => setListening(listening));
  const closeHandlers: Array<() => void | Promise<void>> = [];
  const cells = new Map<string, Cell<any>>();
  const arrived = new Map<string, { buffer: SharedArrayBuffer; mode: "read" | "write" }>();
  let closing = false;

  channel.onControl = async (m: any) => {
    if (m?.k !== "close" || closing) return;
    closing = true;
    for (const h of closeHandlers) {
      try {
        await h();
      } catch (e) {
        report(e);
      }
    }
    process.exit(0);
  };

  // The main thread's cells arrive by postMessage, which this thread's loop delivers at once.
  (globalThis as any).addEventListener("message", (e: MessageEvent) => {
    const cell = (e.data as CellMessage | undefined)?.__bunkitCell;
    if (!cell) return;
    arrived.set(cell.name, { buffer: cell.buffer, mode: cell.mode });
    const pending = cells.get(cell.name);
    if (pending && !pending.attached) {
      const written = { ...pending.local };
      pending.attach(cell.buffer);
      if (cell.mode === "read") pending.write(written);
    }
  });

  // Delivery: wait on the ring's idle word with Atomics.waitAsync, which keeps this thread's loop
  // running. A pending waitAsync does not keep a worker alive (measured), so a thread that is
  // listening holds a timer while it does.
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  function setListening(on: boolean): void {
    if (on && !keepAlive) keepAlive = setInterval(() => {}, 1 << 30);
    if (!on && keepAlive) {
      clearInterval(keepAlive);
      keepAlive = undefined;
    }
  }
  const run = (h: Handler, message: unknown) => {
    try {
      h(message);
    } catch (e) {
      report(e);
    }
  };
  const control = channel.inboundControl;
  (async () => {
    for (;;) {
      channel.drain(Infinity, run);
      if (!channel.armIdle()) continue;
      const wait = (Atomics as any).waitAsync(control, IDLE, 1);
      if (wait.async) await wait.value;
    }
  })();

  function report(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    channel.sendControl({ k: "error", name: err.name, message: err.message, stack: err.stack ?? String(err) });
  }
  // An uncaught error reaches the main thread through the channel, with its stack, during a menu
  // as at any other time; the thread then ends, and is not restarted.
  process.on("uncaughtException", (e) => {
    report(e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    report(e);
    process.exit(1);
  });
  process.on("exit", (code) => {
    channel.sendControl({ k: "exit", code });
    channel.close();
  });

  return {
    name: String(data.name),
    channel,
    cell(layout: CellLayout<any>, mode: "read" | "write"): any {
      let cell = cells.get(layout.name);
      if (!cell) {
        cell = new Cell(layout);
        cells.set(layout.name, cell);
        const got = arrived.get(layout.name);
        if (got) cell.attach(got.buffer);
      }
      const theirs = arrived.get(layout.name)?.mode;
      if (theirs && theirs === mode) {
        throw new Error(`cell "${layout.name}": the main thread's end is the one to ${mode} it already`);
      }
      return cellHandle(cell, mode);
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
  } as Parent;
}

/**
 * This thread's end of its channel and cells, inside a thread started with {@link spawnThread};
 * `undefined` anywhere else (the main thread, or a worker started some other way).
 */
export const parent: Parent | undefined =
  !isMainThread && (workerData as any)?.bunkit ? startThreadSide((workerData as any).bunkit) : undefined;
