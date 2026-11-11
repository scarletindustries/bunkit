// GPU time per pass, from the GPU's own clock, in a frame that is running anyway.
//
//   const timer = GPUTimer.create(gpu());
//   view.onFrame((frame) => {
//     const slot = timer?.begin(frame);       // every pass this frame opens is timed…
//     if (slot) slot.group = "shadows";
//     drawShadows(frame);
//     if (slot) slot.group = "lighting";       // …under whichever group is current
//     light(frame);
//   });
//   timer?.latest;                            // { frameMs, groups: { shadows: 1.4, lighting: 3.2 } }
//
// A command buffer's GPUStartTime and GPUEndTime say what a whole frame cost; this says what
// each part of it cost, on screen, without splitting the frame into command buffers (which the
// GPU then overlaps, so their spans double-count) or timing it offline (which is not the frame
// the screen gets). Metal writes a timestamp at the start and the end of each pass into a
// counter sample buffer (`MTLCounterSamplingPointAtStageBoundary`, which every Apple GPU
// supports); the timer reads them back a few frames later, once the GPU has finished with them.
// On an M2 Pro the timestamps are nanoseconds.
//
// The timer keeps a small ring of sample buffers, one per frame in flight, and skips timing a
// frame whose slot the GPU is still using rather than wait for it. `GPUTimer.create` returns
// `null` where the GPU cannot sample timestamps at pass boundaries, so a caller can carry on
// without one.

import { objc } from "../objc.ts";
import { asPointer, NIL, ptr, toArrayBuffer } from "../bridge.ts";
import { CommandBufferStatus, type GPU, type MTLObject } from "./gpu.ts";
import type { Frame, PassSamples, PassTimer } from "./frame.ts";

/** What one timed frame cost. */
export interface FrameTiming {
  /**
   * From the first pass's start — or the end of the frame before, if the GPU was still on it —
   * to the last pass's end, milliseconds: the GPU's time on this frame.
   */
  frameMs: number;
  /**
   * Each group's share of {@link frameMs}, milliseconds, by group: what each of its passes
   * added to the frame — from its start, or the end of every pass before it, whichever is
   * later, to its end (see {@link timingOf}). The shares sum to the frame, less any gap.
   */
  groups: Record<string, number>;
  /** How many passes were timed. */
  passes: number;
  /** When the last pass ended, milliseconds on the GPU's clock. */
  endMs: number;
}

/** MTLCounterErrorValue: a sample the GPU could not take. */
const ERROR_VALUE = 0xffffffffffffffffn;

/** One frame's sample buffer and what each pair of samples in it belongs to. */
class Slot implements PassTimer {
  readonly buffer: MTLObject;
  readonly capacity: number;
  /** The group each pass's pair of samples is filed under, in pair order. */
  readonly owners: string[] = [];
  /** The group passes opened from now on are filed under. */
  group = "frame";
  /** The command buffer this slot's frame is in, retained until it has been read. */
  commands: MTLObject | undefined;

  constructor(buffer: MTLObject, capacity: number) {
    this.buffer = buffer;
    this.capacity = capacity;
  }

  /** The next pair of samples, filed under the current group; `undefined` when full. */
  next(_label?: string): PassSamples | undefined {
    const pair = this.owners.length;
    if ((pair + 1) * 2 > this.capacity) return undefined;
    this.owners.push(this.group);
    return { buffer: this.buffer, start: pair * 2, end: pair * 2 + 1 };
  }
}

/** Per-pass GPU timing for a frame loop. See the module note. */
export class GPUTimer {
  readonly #slots: Slot[];
  #at = 0;
  #latest: FrameTiming | undefined;
  /** When the last frame read back ended, GPU milliseconds; the next is charged from there. */
  #lastEnd = Number.NEGATIVE_INFINITY;

  private constructor(slots: Slot[]) {
    this.#slots = slots;
  }

  /**
   * A timer for frames of up to `passes` passes, with a slot for each of `frames` frames in
   * flight — or `null` where the GPU cannot sample timestamps at pass boundaries. Side
   * effect: allocates the counter sample buffers.
   */
  static create(gpu: GPU, options: { passes?: number; frames?: number } = {}): GPUTimer | null {
    try {
      const device = gpu.device;
      // MTLCounterSamplingPointAtStageBoundary.
      if (!device.supportsCounterSampling_(0)) return null;
      const sets = device.counterSets();
      let timestamps: MTLObject | undefined;
      for (let i = 0; i < Number(sets?.count() ?? 0); i++) {
        const set = sets.objectAtIndex_(i);
        if (String(set.name()) === "timestamp") timestamps = set;
      }
      if (!timestamps) return null;
      const passes = Math.max(1, Math.round(options.passes ?? 64));
      const slots: Slot[] = [];
      for (let i = 0; i < Math.max(2, Math.round(options.frames ?? 4)); i++) {
        const d = objc.MTLCounterSampleBufferDescriptor.alloc().init();
        d.setCounterSet_(timestamps);
        // Shared: read back by the CPU without a blit.
        d.setStorageMode_(0);
        d.setSampleCount_(passes * 2);
        d.setLabel_(`gpu timer ${i}`);
        const error = new BigUint64Array(1);
        const buffer = device.newCounterSampleBufferWithDescriptor_error_(d, ptr(error));
        if (!buffer || buffer.ptr === NIL) return null;
        slots.push(new Slot(buffer, passes * 2));
      }
      return new GPUTimer(slots);
    } catch {
      return null;
    }
  }

  /**
   * Time `frame`: its passes from now on are timed (see `Frame.timing`), under the returned
   * slot's `group`. Returns `undefined` — and leaves the frame untimed — when the slot it would
   * use still belongs to a frame the GPU has not finished. Side effect: reads back the frame
   * that last used the slot, updating {@link latest}.
   */
  begin(frame: Frame): { group: string } | undefined {
    const slot = this.#slots[this.#at]!;
    if (slot.commands) {
      if (Number(slot.commands.status()) < CommandBufferStatus.completed) return undefined;
      this.#read(slot);
    }
    this.#at = (this.#at + 1) % this.#slots.length;
    slot.owners.length = 0;
    slot.group = "frame";
    // Retained until read back: the run loop's pool would otherwise let it go first.
    frame.commands.retain();
    slot.commands = frame.commands;
    frame.timing = slot;
    return slot;
  }

  /** The last frame read back: its span and each group's time. `undefined` until one has been. */
  get latest(): FrameTiming | undefined {
    return this.#latest;
  }

  /** Read back a finished slot into {@link latest}, and let go of its command buffer. */
  #read(slot: Slot): void {
    const commands = slot.commands;
    slot.commands = undefined;
    const pairs = slot.owners.length;
    try {
      if (pairs === 0 || Number(commands.status()) !== CommandBufferStatus.completed) return;
      const data = slot.buffer.resolveCounterRange_({ location: 0, length: pairs * 2 });
      if (!data || data.ptr === NIL) return;
      const length = Number(data.length());
      if (length < pairs * 16) return;
      const stamps = new BigUint64Array(toArrayBuffer(asPointer(data.bytes()), 0, pairs * 16).slice(0));
      this.#latest = timingOf(stamps, slot.owners, this.#lastEnd);
      if (this.#latest.passes > 0) this.#lastEnd = this.#latest.endMs;
    } finally {
      commands?.release();
    }
  }

  /** Let go of any command buffer still held. The timer can be used again afterwards. */
  dispose(): void {
    for (const slot of this.#slots) {
      slot.commands?.release();
      slot.commands = undefined;
    }
  }
}

/**
 * A frame's timing from its timestamps — a start and an end per pass, nanoseconds, in the order
 * the passes were encoded — and the group each pass is filed under. Pure. A pass whose samples
 * the GPU could not take, or whose end is before its start, counts nothing.
 *
 * A pass's own span is not what it cost: an Apple GPU starts the next pass while the last is
 * still running (a compute pass is "started" as soon as it is scheduled, and waits there on
 * what it reads), so the spans overlap and their sum is far more than the frame — measured on a
 * Fancy frame of 11.6 ms, 26 ms. Each pass is instead charged what it *added*: from its start,
 * or the latest end of the passes before it, whichever is later, to its end. The charges
 * partition the frame, so they sum to it (less any time the GPU was idle). With frames in
 * flight the same holds across frames: `previousEndMs`, when the frame before ended (GPU
 * milliseconds), is where this frame's first passes are charged from, so they do not take the
 * tail of the frame before as their own.
 */
export function timingOf(
  stamps: BigUint64Array, owners: readonly string[], previousEndMs = Number.NEGATIVE_INFINITY,
): FrameTiming {
  const groups: Record<string, number> = {};
  let first = Number.POSITIVE_INFINITY;
  let last = previousEndMs;
  let passes = 0;
  for (let i = 0; i < owners.length; i++) {
    const a = stamps[i * 2]!;
    const b = stamps[i * 2 + 1]!;
    if (a === ERROR_VALUE || b === ERROR_VALUE || a === 0n || b < a) continue;
    const start = Number(a) / 1e6;
    const end = Number(b) / 1e6;
    const owner = owners[i]!;
    const added = Math.max(0, end - Math.max(start, last));
    groups[owner] = (groups[owner] ?? 0) + added;
    first = Math.min(first, Math.max(start, previousEndMs));
    last = Math.max(last, end);
    passes++;
  }
  return { frameMs: passes > 0 ? Math.max(0, last - first) : 0, groups, passes, endMs: passes > 0 ? last : 0 };
}
