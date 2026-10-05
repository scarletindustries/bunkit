// When a drawn frame actually reached the screen — measured, never assumed.
//
// A frame is not on screen when it is drawn. It is encoded, rendered, handed to
// the window server, composited and scanned out at a vsync, and how long all of
// that takes depends on the display and on how many frames are queued in front
// of it. On a 120 Hz MacBook panel it measured 24–32 ms: three or four refreshes.
// Anything synced to music feels that — a light that changes on the beat is seen
// a thirtieth of a second after it.
//
// Metal says when: every CAMetalDrawable has a presentedTime, the host time (in
// seconds, the Mach clock `br_now` reads) at which it was displayed — 0 until it
// has been, and for ever if it never is. So each frame is remembered with the
// moment its handlers ran, and polled on later ticks until it reports in. The
// difference is the frame's latency, and a view that knows it can draw what will
// be true when the picture is seen rather than what was true when it was drawn.
//
// Polled rather than delivered by addPresentedHandler: that block runs on a
// Metal thread, and a JS callback entered from there deadlocks Bun — the same
// reason command-buffer completion is polled (see view.ts).

/** What a {@link PresentTracker} has measured. All times in milliseconds. */
export interface PresentStats {
  /** Frames the figures below were taken over. */
  samples: number;
  /** From the frame's handlers running to it being on screen: the median. */
  latencyMs: number;
  /** …and the 95th percentile. */
  latencyP95Ms: number;
  /** The display's refresh interval: the median gap between presentations. */
  refreshMs: number;
  /** Frames drawn and never shown — replaced before a vsync reached them. */
  dropped: number;
  /** Frames drawn and not yet reported shown, right now. */
  pending: number;
}

/** The part of a `CAMetalDrawable` this needs. Structural, so a test can hand over a fake. */
export interface PresentedDrawable {
  /** Host seconds it was displayed at, or `0` until it has been. */
  presentedTime(): number;
  retain(): unknown;
  release(): unknown;
}

/** How many frames the rolling figures are taken over. Two seconds at 120 Hz. */
export const PRESENT_WINDOW = 240;

/**
 * How long a frame may go unshown before it counts as dropped, in ms. Far
 * longer than any queue: a frame still unshown after a quarter of a second was
 * replaced, not delayed.
 */
export const DROP_AFTER_MS = 250;

/**
 * How long a frame is assumed to take to reach the screen, in ms, until the
 * display has reported enough frames to say. Measured on a 120 Hz MacBook
 * panel: 24–32.
 */
export const ASSUMED_LATENCY_MS = 30;

/** Frames the display must have reported before its figure replaces the assumption. */
export const MIN_PRESENT_SAMPLES = 30;

/**
 * How long a frame drawn now will take to reach the screen, in ms: the measured
 * median once there are {@link MIN_PRESENT_SAMPLES} frames behind it,
 * {@link ASSUMED_LATENCY_MS} before that. Pure.
 *
 * What something synced to a clock should add to *now* when it decides what to
 * draw: the picture is seen then, not now.
 */
export function screenLatencyMs(stats: Pick<PresentStats, "samples" | "latencyMs">): number {
  return stats.samples >= MIN_PRESENT_SAMPLES ? stats.latencyMs : ASSUMED_LATENCY_MS;
}

interface Tracked {
  drawable: PresentedDrawable;
  /** Host ms the frame's handlers ran at. */
  drawnMs: number;
}

/**
 * Tracks drawn frames until the display says they were shown.
 *
 * {@link track} each frame as it is presented, {@link poll} once per tick, read
 * {@link stats}. Holds a retain on each drawable only until it reports in or is
 * given up on; {@link dispose} releases whatever is left.
 */
export class PresentTracker {
  #tracked: Tracked[] = [];
  readonly #latencies: number[] = [];
  readonly #presents: number[] = [];
  #dropped = 0;
  /** The figures, until something new reports in. */
  #figures: Omit<PresentStats, "pending"> | undefined;

  /**
   * Remember a frame that has just been presented.
   *
   * Side effect: retains the drawable until it reports in or is given up on.
   *
   * @param drawable the frame's `CAMetalDrawable`.
   * @param drawnMs the host time, in ms, the frame's handlers ran at.
   */
  track(drawable: PresentedDrawable, drawnMs: number): void {
    drawable.retain();
    this.#tracked.push({ drawable, drawnMs });
  }

  /**
   * Collect every frame the display has shown since the last poll.
   *
   * Side effects: releases the drawables that have reported in (or been given
   * up on) and updates the rolling figures. One Objective-C property read per
   * frame in flight, of which there are a handful.
   *
   * @param nowMs the host clock, in ms.
   */
  poll(nowMs: number): void {
    let i = 0;
    while (i < this.#tracked.length) {
      const entry = this.#tracked[i]!;
      let shown = 0;
      try {
        shown = Number(entry.drawable.presentedTime());
      } catch {
        shown = 0;
      }
      if (shown > 0) {
        const shownMs = shown * 1000;
        push(this.#latencies, shownMs - entry.drawnMs);
        push(this.#presents, shownMs);
      } else if (nowMs - entry.drawnMs > DROP_AFTER_MS) {
        this.#dropped++;
      } else {
        i++;
        continue;
      }
      entry.drawable.release();
      this.#tracked.splice(i, 1);
      this.#figures = undefined;
    }
  }

  /** Frames presented and not yet reported shown. */
  get pending(): number {
    return this.#tracked.length;
  }

  /**
   * The rolling figures. A copy, and cheap to ask for every frame: they are
   * worked out once per frame that reports in, not once per read.
   */
  get stats(): PresentStats {
    this.#figures ??= this.#compute();
    return { ...this.#figures, pending: this.#tracked.length };
  }

  #compute(): Omit<PresentStats, "pending"> {
    const latencies = [...this.#latencies].sort((a, b) => a - b);
    const presents = [...this.#presents].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < presents.length; i++) gaps.push(presents[i]! - presents[i - 1]!);
    gaps.sort((a, b) => a - b);
    return {
      samples: latencies.length,
      latencyMs: quantile(latencies, 0.5),
      latencyP95Ms: quantile(latencies, 0.95),
      refreshMs: quantile(gaps, 0.5),
      dropped: this.#dropped,
    };
  }

  /** Release every drawable still held. Idempotent. */
  dispose(): void {
    for (const entry of this.#tracked) entry.drawable.release();
    this.#tracked = [];
  }
}

/** Append to a bounded rolling window. */
function push(values: number[], value: number): void {
  values.push(value);
  if (values.length > PRESENT_WINDOW) values.shift();
}

/** The `p` quantile of an ascending list, or `0` for an empty one. Pure. */
function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}
