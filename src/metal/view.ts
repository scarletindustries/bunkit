// GPUView: a Metal surface that is also a BunKit view.
//
// Pacing, which is the whole design question here:
//
// The temptation is to let the GPU run free of JavaScript. It is the wrong
// instinct. Presenting faster than the display refreshes changes nothing a
// person can see, and CAMetalLayer's vsync makes nextDrawable block anyway, so
// "faster than Bun" mostly means re-presenting identical pixels. What is
// actually visible is *jitter* — a frame that misses its vsync deadline — and
// decoupling does not fix that; it just presents staler state, which for
// anything synced to music or input is worse than a lower frame rate.
//
// So: pace to the display, and make the per-frame JavaScript cheap enough that
// it is never the limit. Measured on an M2 Pro, a draw call costs about 1.2 us
// from JS, where transforming a node and writing its instance struct costs
// 0.08 us. Twenty thousand animated objects come to 2.3 ms of JavaScript in one
// draw call; the same objects drawn one at a time would not fit in a frame.
//
// Frames are gated on GPU completion rather than a timer: the view keeps at
// most `maxInFlight` command buffers outstanding and skips a tick when the GPU
// has not caught up. That paces to the display without ever blocking the run
// loop, which a blocking nextDrawable would.
//
// When a presented frame then reaches the screen is measured, not assumed,
// from each drawable's own presentedTime — `stats.present`, see present.ts.
//
// One frame per refresh, drawn when the display has somewhere to put it. A
// frame holds a drawable for three or four refreshes — rendered, queued,
// composited, on screen until replaced — and a view that draws whenever the
// loop comes round finds them all taken and blocks in nextDrawable until a
// vsync frees one. Measured on a 120 Hz panel, a third of the main thread went
// there. So the wait happens on a thread of its own (native/src/drawables.m):
// it keeps one drawable ready, taking the next the moment the display lets go
// of one, and wakes the run loop when it has. `frameDue` says whether one is
// ready; a host asks before doing a frame's work, and the loop here asks before
// drawing. A frame is then drawn exactly when the display can take it, and the
// main thread never waits for it.
//
// Measured on a bare scene at 120 Hz: drawn to shown in 31.4 ms at 119 fps, and
// no time at all in nextDrawable, where drawing whenever the loop came round
// took 31.9 ms and waited 3.1 ms of every frame for a drawable. Two options
// that were measured and not taken: a CAMetalDisplayLink hands over free
// drawables too, but in a window on macOS 26 it targets five refreshes out
// whatever its preferredFrameLatency (41 ms); and a two-drawable layer is
// quicker to the screen (23 ms) but, with one drawable waiting for the main
// thread, manages only 84 frames a second.
//
// Completion is *polled*, not delivered by a handler block, and that is not a
// shortcut. Metal invokes addCompletedHandler: on its own thread; a JS callback
// entered from there deadlocks Bun, because the interpreter it needs is the
// thread that is waiting. Reading commandBuffer.status() at the top of the next
// tick asks the same question from the thread that is allowed to ask it.

import { objc, withPool, wrap } from "../objc.ts";
import { lib, NIL } from "../bridge.ts";
import { onFrame, setAnimating } from "../runtime.ts";
import { View, type ViewOptions } from "../ui/view.ts";
import { input, type Input } from "../ui/input.ts";
import {
  CommandBufferStatus, gpu, PixelFormat, Texture,
  type GPU, type MTLObject, type PixelFormatName,
} from "./gpu.ts";
import { Frame } from "./frame.ts";
import { PresentTracker, type PresentedDrawable, type PresentStats } from "./present.ts";

export interface GPUViewOptions extends ViewOptions {
  format?: PixelFormatName;
  /** Create and manage a depth texture matching the drawable. Default true. */
  depth?: boolean | PixelFormatName;
  /** Multisample count. 1, 2 or 4; 4 is the usual choice for clean edges. */
  sampleCount?: number;
  /** Frames the GPU may be working on at once. 2 is smooth and low-latency. */
  maxInFlight?: number;
  /** Cap the frame rate. Omit to run at the display's refresh. */
  fps?: number;
  animate?: boolean;
  onFrame?: (frame: Frame, view: GPUView) => void;
}

export interface GPUViewStats {
  /** Frames presented in the last second. */
  fps: number;
  /**
   * Milliseconds of JavaScript per frame: your handlers plus the encoding.
   *
   * Excludes the wait for a drawable, which is reported separately. Rolling
   * them together makes every frame look like it costs a vsync interval and
   * hides whether the CPU is actually the limit.
   */
  cpuMs: number;
  /** Milliseconds blocked in nextDrawable, which is the display pacing you. */
  waitMs: number;
  /**
   * Milliseconds the GPU spent on the last finished frame, from its own timestamps: from when
   * it started on that frame, or finished the one before, whichever is later, to when it
   * finished. With two frames in flight the GPU starts the next before the last is done and
   * the two overlap, and the plain start-to-end span then counts the wait for the last as
   * this frame's work: measured on an M2 Pro, a frame the GPU turned round in 14 ms (70 fps)
   * read 16 ms.
   */
  gpuMs: number;
  /** Ticks skipped because the GPU had not caught up. */
  skipped: number;
  /**
   * Frames drawn into a drawable that was already free rather than one the
   * main thread had to wait for — see `frameDue`.
   */
  ready: number;
  /**
   * When frames actually reached the screen, from each drawable's own
   * `presentedTime`: `present.latencyMs` is the median from a frame's handlers
   * running to it being displayed. Zeros until the display has reported in.
   * See present.ts.
   */
  present: PresentStats;
  frame: number;
  drawableSize: { width: number; height: number };
}

/**
 * What one frame's command buffer cost the GPU, milliseconds, from its own `GPUStartTime` and
 * `GPUEndTime` (seconds) and when the GPU finished the frame before it (`previousEnd`, seconds,
 * 0 for none). Pure. The overlap with the frame before is that frame's: with frames in flight
 * the GPU starts the next before the last is done, and the plain span counts the wait.
 */
export function gpuBusyMs(start: number, end: number, previousEnd: number): number {
  if (!(end > start)) return 0;
  return (end - Math.max(start, Math.min(previousEnd, end))) * 1000;
}

export class GPUView extends View {
  readonly gpu: GPU;
  readonly layer: MTLObject;
  readonly format: number;
  readonly sampleCount: number;
  /** Multisample colour target, when sampleCount > 1. */
  msaaTexture: Texture | null = null;
  depthTexture: Texture | null = null;

  #depthFormat: PixelFormatName | null;
  #handlers: ((frame: Frame, view: GPUView) => void)[] = [];
  #stop: (() => void) | null = null;
  /** Command buffers the GPU has not finished. Drained by polling status(). */
  #inFlight: MTLObject[] = [];
  #maxInFlight: number;
  #minInterval: number;
  #size = { width: 0, height: 0 };
  #start = 0;
  #last = 0;
  /**
   * The scene time of the last frame drawn or captured, seconds — what the next capture
   * continues from. A host that drives `draw(time)` itself (rather than the view's own tick)
   * sets it through that call, so a capture is a moment in the same timeline, not time zero.
   */
  #time = 0;
  #frame = 0;
  #skipped = 0;
  #cpuMs = 0;
  #waitMs = 0;
  #gpuMs = 0;
  /** When the GPU finished the last frame retired, seconds on its clock. */
  #gpuEnd = 0;
  #fps = 0;
  #fpsFrames = 0;
  #fpsMark = 0;
  #disposed = false;
  readonly #present = new PresentTracker();
  /** The native thread that keeps a drawable ready. See `frameDue`. */
  #pump: bigint | null = null;
  /** Set once making the pump has failed; the view then waits in nextDrawable as before. */
  #noPump = false;
  #ready = 0;

  constructor(options: GPUViewOptions = {}) {
    const g = gpu();
    const native = objc.NSView.alloc().init();
    const layer = objc.CAMetalLayer.layer();
    layer.setDevice_(g.device);
    layer.setPixelFormat_(PixelFormat[options.format ?? "bgra8unorm"]);
    // Two or three lets the GPU work on the next frame while one is on screen.
    layer.setMaximumDrawableCount_(Math.max(2, Math.min(3, (options.maxInFlight ?? 2) + 1)));
    // Order matters: setting wantsLayer first makes AppKit install its own.
    native.setLayer_(layer);
    native.setWantsLayer_(true);

    super(native, options);

    this.gpu = g;
    this.layer = layer;
    this.format = PixelFormat[options.format ?? "bgra8unorm"];
    this.sampleCount = options.sampleCount ?? 1;
    this.#depthFormat =
      options.depth === false ? null
      : typeof options.depth === "string" ? options.depth
      : "depth32float";
    this.#maxInFlight = Math.max(1, options.maxInFlight ?? 2);
    this.#minInterval = options.fps ? 1 / options.fps : 0;

    if (options.height === undefined && options.minHeight === undefined) {
      this.constrain("height", ">=", 160);
    }
    if (options.onFrame) this.#handlers.push(options.onFrame);
    if (options.animate !== false) this.start();
  }

  onFrame(fn: (frame: Frame, view: GPUView) => void): this {
    this.#handlers.push(fn);
    return this;
  }

  /**
   * What a click must land in to count as one on this view — `mouse.over` and
   * `mouse.pressedOver` in {@link input}. Default: the view itself. Set it to the container
   * the view shares with overlays of its own (labels over the scene, a transparent view that
   * takes keyboard focus), so a click on those still reaches the scene.
   */
  inputArea: View | undefined;

  /**
   * Keyboard and mouse, with the pointer reported in this view's coordinates.
   *
   *   if (view.input.held("w")) camera.position.z -= speed * frame.dt;
   *   if (view.input.mouse.pressedOver) orbit(view.input.mouse.dx);
   */
  get input(): Input {
    return input().track(this, this.inputArea ?? this);
  }

  start(): this {
    if (this.#stop || this.#disposed) return this;
    this.#start = 0;
    // Ask the run loop for its fast cadence while we are animating, so a 120 Hz
    // display is not capped by the idle 100 Hz tick.
    setAnimating(true);
    this.#stop = onFrame((now) => this.#tick(now));
    return this;
  }

  stop(): this {
    if (!this.#stop) return this;
    this.#stop();
    this.#stop = null;
    setAnimating(false);
    return this;
  }

  /**
   * Whether a frame drawn now would go straight into a free drawable.
   *
   * Ask before doing a frame's work, and skip it when this is false: the
   * drawable thread wakes the run loop the moment the display frees one, so the
   * frame is only put off until the display can take it. Drawing anyway still
   * works; it just waits in nextDrawable, on the main thread, until then.
   *
   * Always true for a view that is not in a window: there is no display to wait
   * for, and the first ask after that starts the thread.
   */
  get frameDue(): boolean {
    if (this.#disposed) return false;
    const pump = this.#drawables();
    if (pump === null) return true;
    return lib.br_drawables_ready(pump) !== 0;
  }

  /** The drawable thread, started on first use once the view is in a window. */
  #drawables(): bigint | null {
    if (this.#pump !== null) return this.#pump;
    if (this.#noPump) return null;
    const window = this.native.window();
    if (!window || window.ptr === NIL) return null;
    const pump = lib.br_drawables_create(this.layer.ptr) as bigint;
    if (!pump || pump === NIL) {
      this.#noPump = true;
      return null;
    }
    lib.br_drawables_arm(pump, 1);
    this.#pump = pump;
    return pump;
  }

  /** The drawable the thread has ready, or `undefined`. Ownership passes to the caller. */
  #takeReady(): MTLObject | undefined {
    if (this.#pump === null) return undefined;
    const drawable = lib.br_drawables_take(this.#pump) as bigint;
    return drawable && drawable !== NIL ? wrap(drawable, true) : undefined;
  }

  /**
   * When frames have been reaching the screen — `stats.present` without the rest of
   * `stats`, for a caller that asks every frame. See present.ts.
   */
  get present(): PresentStats {
    return this.#present.stats;
  }

  get stats(): GPUViewStats {
    return {
      fps: this.#fps,
      cpuMs: this.#cpuMs,
      waitMs: this.#waitMs,
      gpuMs: this.#gpuMs,
      skipped: this.#skipped,
      ready: this.#ready,
      frame: this.#frame,
      drawableSize: { ...this.#size },
      present: this.#present.stats,
    };
  }

  /**
   * Retire finished command buffers, and take the GPU's own timing off them —
   * and collect the frames the display has shown since.
   */
  #reap(): number {
    if (this.#present.pending > 0) this.#present.poll(lib.br_now() * 1000);
    let i = 0;
    while (i < this.#inFlight.length) {
      const buffer = this.#inFlight[i]!;
      if (Number(buffer.status()) >= CommandBufferStatus.completed) {
        const start = Number(buffer.GPUStartTime());
        const end = Number(buffer.GPUEndTime());
        if (end > start) this.#gpuMs = gpuBusyMs(start, end, this.#gpuEnd);
        if (end > this.#gpuEnd) this.#gpuEnd = end;
        this.#inFlight.splice(i, 1);
        // The retain taken when it was committed (see draw). Without it every frame's command
        // buffer outlived its wrapper for good — 1.5 KB of driver memory a frame, 38,752 live
        // command buffers and a footprint growing 6–8 MB a minute in a twelve-minute app run.
        buffer.release();
      } else {
        i++;
      }
    }
    return this.#inFlight.length;
  }

  #tick(now: number): void {
    if (this.#start === 0) {
      this.#start = now;
      this.#last = now;
    }
    if (this.#minInterval && now - this.#last < this.#minInterval) return;
    // The GPU has not finished enough of the previous work: skip rather than
    // queue more, and rather than block the run loop waiting for a drawable.
    if (this.#reap() >= this.#maxInFlight) {
      this.#skipped++;
      return;
    }
    if (!this.frameDue) return;
    const dt = now - this.#last;
    this.#last = now;
    this.draw(now - this.#start, dt);
  }

  /** Size the drawable and the attachments to the view's backing store. */
  #syncSize(): { width: number; height: number } {
    const bounds = this.native.bounds();
    const window = this.native.window();
    const scale = window ? Number(window.backingScaleFactor()) : 2;
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    if (width !== this.#size.width || height !== this.#size.height) {
      this.layer.setContentsScale_(scale);
      this.layer.setDrawableSize_({ width, height });
      this.#size = { width, height };
      if (this.#depthFormat) {
        // shaderRead as well as renderTarget, so a later pass in the same frame
        // can sample it — depth-aware fog, soft particles, depth of field. It
        // costs nothing when nothing reads it, and a texture created without it
        // cannot be given the usage later.
        this.depthTexture = this.gpu.texture({
          width, height, format: this.#depthFormat, usage: ["renderTarget", "shaderRead"],
          sampleCount: this.sampleCount, label: "depth",
        });
      }
      this.msaaTexture = this.sampleCount > 1
        ? this.gpu.texture({
            width, height, format: this.formatName, usage: ["renderTarget"],
            sampleCount: this.sampleCount, label: "msaa",
          })
        : null;
    }
    return this.#size;
  }

  /** The pixel format as a name, for building a pipeline that matches. */
  get formatName(): PixelFormatName {
    for (const [name, value] of Object.entries(PixelFormat)) {
      if (value === this.format) return name as PixelFormatName;
    }
    return "bgra8unorm";
  }

  /**
   * Encode and present one frame, now.
   *
   * Into the drawable the drawable thread has ready when there is one (see
   * `frameDue`); otherwise into the next the layer gives up, which waits until
   * the display frees one. Call it directly for a single still.
   */
  draw(time = 0, dt = 0): void {
    if (this.#disposed || this.#handlers.length === 0) return;
    this.#time = time;
    // Retire finished buffers here too, not only from the tick: draw() is a
    // public entry point, and a caller driving frames by hand would otherwise
    // see gpuMs stuck at zero and the in-flight list grow without bound.
    this.#reap();
    const cpuStart = performance.now();
    let waited = 0;
    let drawn = false;

    withPool(() => {
      const { width, height } = this.#syncSize();
      if (width < 2 || height < 2) return;

      let drawable = this.#takeReady();
      if (drawable) {
        // Taken before a resize: the wrong size for the attachments now.
        const texture = drawable.texture();
        if (Number(texture.width()) !== width || Number(texture.height()) !== height) {
          // Released now, not when the wrapper is collected: a drawable that is never
          // presented stays checked out of the layer's three until it is let go, and
          // the next nextDrawable would wait a whole second for it.
          drawable.dispose();
          drawable = undefined;
        } else {
          this.#ready++;
        }
      }
      if (!drawable) {
        // nextDrawable blocks when every drawable is still on screen or in
        // flight. That is the display pacing us, not work, so it is timed apart.
        const waitStart = performance.now();
        drawable = this.layer.nextDrawable();
        waited = performance.now() - waitStart;
        if (!drawable || drawable.ptr === NIL) return;
      }

      const commands = this.gpu.queue.commandBuffer();
      commands.setLabel_(`frame ${this.#frame}`);
      // The moment the handlers read whatever they draw — what the frame's
      // latency to the screen is measured from.
      const drawnMs = lib.br_now() * 1000;

      const frame = new Frame(commands, {
        time, dt, index: this.#frame, width, height,
      });
      frame.drawable = drawable;
      frame.colorTexture = this.msaaTexture ? this.msaaTexture.native : drawable.texture();
      frame.resolveTexture = this.msaaTexture ? drawable.texture() : undefined;
      frame.depthTexture = this.depthTexture?.native;

      for (const fn of this.#handlers) {
        try {
          fn(frame, this);
        } catch (e) {
          console.error("[GPUView] frame handler failed:", e);
        }
      }

      commands.presentDrawable_(drawable);
      commands.commit();
      this.#present.track(drawable as PresentedDrawable, drawnMs);
      // Retained past the pool: #reap polls its status on a later tick.
      this.#inFlight.push(commands.retain());
      this.#frame++;
      drawn = true;
    });

    if (!drawn) return;
    this.#waitMs = waited;
    this.#cpuMs = performance.now() - cpuStart - waited;
    this.#fpsFrames++;
    if (time - this.#fpsMark >= 1) {
      this.#fps = Math.round(this.#fpsFrames / Math.max(1e-6, time - this.#fpsMark));
      this.#fpsFrames = 0;
      this.#fpsMark = time;
    }
  }

  /**
   * Render one frame into an off-screen texture and read it back as RGBA.
   *
   * The same handlers run, so a capture is the same frame the view would have
   * drawn — which is how this is tested with nobody watching.
   *
   * Time carries on from the last frame drawn or captured, `dt` (default 1/60 s) later, so a
   * run of captures is a run of consecutive frames — a strobe flashes, a dancer moves — rather
   * than the same instant again. Pass `time` to render a particular moment instead.
   */
  capture(
    width = 512,
    height = 384,
    options: { time?: number; dt?: number } = {},
  ): { width: number; height: number; pixels: Uint8Array } {
    const dt = options.dt ?? 1 / 60;
    const time = options.time ?? this.#time + dt;
    this.#time = time;
    // Attachments have to match the pipelines the handlers will set, and those
    // were built for this view's sample count. A multisampled pipeline drawing
    // into single-sampled attachments is a validation error that only shows up
    // when someone runs with Metal validation on.
    const multisampled = this.sampleCount > 1;
    const readable = this.gpu.texture({
      width, height, format: this.formatName,
      usage: ["renderTarget", "shaderRead"], storage: "shared", label: "capture",
    });
    const color = multisampled
      ? this.gpu.texture({
          width, height, format: this.formatName, usage: ["renderTarget"],
          sampleCount: this.sampleCount, label: "capture msaa",
        })
      : readable;
    const depth = this.#depthFormat
      ? this.gpu.texture({
          width, height, format: this.#depthFormat, usage: ["renderTarget"],
          sampleCount: this.sampleCount, label: "capture depth",
        })
      : null;

    this.gpu.submit((commands) => {
      const frame = new Frame(commands, {
        time, dt, index: this.#frame, width, height,
      });
      frame.colorTexture = color.native;
      frame.resolveTexture = multisampled ? readable.native : undefined;
      frame.depthTexture = depth?.native;
      for (const fn of this.#handlers) fn(frame, this);
    });

    const bgra = readable.read();
    // BGRA on the GPU, RGBA for everyone else.
    const pixels = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      pixels[i] = bgra[i + 2]!;
      pixels[i + 1] = bgra[i + 1]!;
      pixels[i + 2] = bgra[i]!;
      pixels[i + 3] = bgra[i + 3]!;
    }
    return { width, height, pixels };
  }

  dispose(): void {
    this.stop();
    this.#disposed = true;
    for (const buffer of this.#inFlight) buffer.release();
    this.#inFlight = [];
    this.#present.dispose();
    if (this.#pump !== null) {
      lib.br_drawables_destroy(this.#pump);
      this.#pump = null;
    }
    this.depthTexture = null;
    this.msaaTexture = null;
  }
}

