// MetalFX: Apple's upscalers, as two objects.
//
//   const fx = TemporalScaler.create(gpu(), {
//     input: [960, 540], output: [1920, 1080],
//     color: "rgba16float", depth: "depth32float", motion: "rg16float", output: "rgba16float",
//   });
//   fx?.encode(frame.commands, { color, depth, motion, output, jitter: [jx, jy], motionScale: [-960, -540] });
//
// The temporal scaler is TAA and upscaling in one, tuned by Apple for its own GPUs: the
// jittered, low-resolution frame, its depth and its motion in; an anti-aliased frame at the
// output's resolution out. The spatial scaler is a single-frame upscale (no history), for a
// picture that is already anti-aliased.
//
// MetalFX is a framework of its own, not part of Metal, and nothing in a Bun process loads it:
// its classes are not there until `MetalFX.framework` is. `metalFXAvailable()` loads it (once,
// through NSBundle — the class lookups are cached, so it must happen before the first one) and
// says whether this machine has it. Everything here returns `null` rather than throwing where
// MetalFX is missing or refuses a configuration, so a caller can keep a fallback of its own.
//
// Conventions worth knowing before reading a MetalFX picture:
//
// - **Motion** is in pixels of the *input*, after `motionScale`, and points from where a pixel
//   is now to where it was last frame: an object moving 10 pixels down and right reads
//   (−10, −10). A renderer whose motion vectors are "now − then" in UV passes the negative of
//   the input size as `motionScale`.
// - **Jitter** is the sub-pixel offset, in input pixels, the frame was rendered at.
// - **Reset** on a cut, or the first frame shows the last view.
// - **Range.** The temporal scaler keeps its history as x / (1 + x) of the input divided by
//   `preExposure`, in half floats: measured on an M2 Pro (macOS 26.6), a pixel whose value is
//   past 2047 × `preExposure` comes out at that, 100 comes out 96.5–106.8 and 1000 anywhere from
//   681 to 2047 (with `preExposure` 1), while everything under 1 is exact. A renderer whose
//   picture is pre-exposed (middle grey near 0.18, a lens in the thousands) sets `preExposure`
//   to 32, which puts the clip at 65504 — a half float's largest — and keeps 0.1% steps to 32.
//   The exposure texture only steers its internal weights; it changes no output value.
//
// Building one is slow: `newTemporalScalerWithDevice:` returns once MetalFX has made its
// pipelines, 50–90 ms on an M2 Pro, a few hundred the first time in a process, more than a
// second with `requiresSynchronousInitialization`. `TemporalScaler.build` (and
// `FrameInterpolator.build`) make it on a background queue instead (native/src/metalfx.m) and
// hand back an {@link EffectBuild} to poll — nothing waits on the calling thread.
//
// **Dynamic resolution.** A scaler built with `dynamic: [min, max]` takes any input content
// size whose scale to the output is within that range, so a renderer that moves its render
// scale every second keeps one scaler (and its history). Its input textures are the input
// size; each frame's picture is the top-left `content` of them.

import { objc, tryClass, wrap } from "../objc.ts";
import { lib, NIL } from "../bridge.ts";
import { PixelFormat, type GPU, type MTLObject, type PixelFormatName, type Texture } from "./gpu.ts";

/** MTLTextureUsage bits, by name, as MetalFX reports what it needs. */
const USAGE = { shaderRead: 1, shaderWrite: 2, renderTarget: 4 } as const;

let loaded: boolean | undefined;

/**
 * Whether MetalFX is on this machine and works with `gpu`'s device. Loads the framework the
 * first time it is asked (a few milliseconds); answers from memory after that. Side effect:
 * `MetalFX.framework` is loaded into the process.
 */
export function metalFXAvailable(gpu: GPU): boolean {
  if (loaded === undefined) {
    try {
      const bundle = objc.NSBundle.bundleWithPath_("/System/Library/Frameworks/MetalFX.framework");
      loaded = !!bundle && bundle.ptr !== NIL && !!bundle.load();
    } catch {
      loaded = false;
    }
  }
  if (!loaded) return false;
  const temporal: MTLObject = tryClass("MTLFXTemporalScalerDescriptor");
  return !!temporal && !!temporal.supportsDevice_(gpu.device);
}

/** The usage names a MetalFX usage mask asks for. Pure. */
export function usageNames(mask: number): Array<keyof typeof USAGE> {
  return (Object.keys(USAGE) as Array<keyof typeof USAGE>).filter((k) => (mask & USAGE[k]) !== 0);
}

/** What a temporal scaler is built for. Fixed for its life: a new size is a new scaler. */
export interface TemporalScalerOptions {
  /** The input (render) size, pixels. */
  input: readonly [number, number];
  /** The output size, pixels. At most `maxScale` × the input on each axis. */
  output: readonly [number, number];
  /** Pixel formats of the textures it will be handed. */
  color: PixelFormatName;
  depth: PixelFormatName;
  motion: PixelFormatName;
  outputFormat: PixelFormatName;
  /**
   * A reactive mask's format, when there will be one: a single channel, 0–1, of how much each
   * input pixel should trust this frame over the history (a strobe, a chase). Needs macOS 15.
   */
  reactive?: PixelFormatName;
  /** Let MetalFX meter the picture itself. Off: the input is treated as already exposed. */
  autoExposure?: boolean;
  /**
   * Dynamic resolution: the range of output-over-content scales it will be handed, e.g.
   * `[1, 3]`. The input textures are then always `input` in size and each frame's picture is
   * the top-left `content` of them (see {@link TemporalScalerInputs.content}).
   */
  dynamic?: readonly [number, number];
  label?: string;
}

/** One frame's inputs to a temporal scaler. Textures must match the formats it was built for. */
export interface TemporalScalerInputs {
  color: Texture | MTLObject;
  depth: Texture | MTLObject;
  motion: Texture | MTLObject;
  output: Texture | MTLObject;
  /** A 1×1 texture whose red is the exposure to apply before accumulating. Optional. */
  exposure?: Texture | MTLObject;
  /** The reactive mask, for a scaler built with `reactive`. */
  reactive?: Texture | MTLObject;
  /** The sub-pixel offset this frame was rendered at, input pixels. */
  jitter: readonly [number, number];
  /** What the motion texture's values are multiplied by to make input pixels (see the note above). */
  motionScale: readonly [number, number];
  /** Drop the history: a camera cut, a new scene. */
  reset?: boolean;
  /** Whether depth 0 is the far plane. */
  depthReversed?: boolean;
  /**
   * The size of this frame's picture within the input textures, for a scaler built `dynamic`;
   * the whole input otherwise.
   */
  content?: readonly [number, number];
  /**
   * What the input colour was multiplied by: MetalFX divides it out before accumulating and
   * multiplies it back after, so it sets where the history's range sits (see the note above).
   * 1 when left out.
   */
  preExposure?: number;
}

/** `Texture` or a raw MTLTexture, as the raw object. */
function raw(t: Texture | MTLObject): MTLObject {
  return (t as Texture)?.native ?? t;
}

/**
 * MetalFX's temporal upscaler. Build one with {@link TemporalScaler.create}, which returns
 * `null` where MetalFX is missing or will not take the sizes — so a caller always has a way to
 * fall back.
 */
export class TemporalScaler {
  /** The `MTLFXTemporalScaler` itself. */
  readonly native: MTLObject;
  readonly input: readonly [number, number];
  readonly output: readonly [number, number];
  /** The texture usages MetalFX needs each input and the output to have been made with. */
  readonly usage: { color: number; depth: number; motion: number; output: number; reactive: number };
  readonly reactive: boolean;

  private constructor(native: MTLObject, o: TemporalScalerOptions) {
    this.native = native;
    this.input = [o.input[0], o.input[1]];
    this.output = [o.output[0], o.output[1]];
    this.reactive = o.reactive !== undefined;
    // An Objective-C proxy answers every property with a method, so ask the object itself.
    const read = (name: string): number => {
      try {
        return native.respondsTo(name) ? Number(native[name]()) : 0;
      } catch {
        return 0;
      }
    };
    this.usage = {
      color: read("colorTextureUsage"),
      depth: read("depthTextureUsage"),
      motion: read("motionTextureUsage"),
      output: read("outputTextureUsage"),
      reactive: this.reactive ? read("reactiveTextureUsage") : 0,
    };
  }

  /**
   * The range of output-over-input scales this device's temporal scaler supports, per axis —
   * `[1, 3]` on an M2 — or `null` without MetalFX.
   */
  static scaleRange(gpu: GPU): [number, number] | null {
    if (!metalFXAvailable(gpu)) return null;
    const D: MTLObject = tryClass("MTLFXTemporalScalerDescriptor");
    try {
      return [Number(D.supportedInputContentMinScaleForDevice_(gpu.device)), Number(D.supportedInputContentMaxScaleForDevice_(gpu.device))];
    } catch {
      // Before macOS 14 the range was not published; 1–2 was what every device took.
      return [1, 2];
    }
  }

  /**
   * The descriptor for `o`, or `null` where MetalFX is missing, the scale is outside
   * {@link scaleRange}, or this macOS lacks a feature `o` asks for. Side effect: loads MetalFX.
   */
  static #descriptor(gpu: GPU, o: TemporalScalerOptions): MTLObject | null {
    const range = TemporalScaler.scaleRange(gpu);
    if (!range) return null;
    const sx = o.output[0] / Math.max(1, o.input[0]);
    const sy = o.output[1] / Math.max(1, o.input[1]);
    if (o.dynamic) {
      if (o.dynamic[0] < range[0] - 1e-6 || o.dynamic[1] > range[1] + 1e-6 || o.dynamic[0] > o.dynamic[1]) return null;
    } else if (Math.min(sx, sy) < range[0] - 1e-6 || Math.max(sx, sy) > range[1] + 1e-6) {
      return null;
    }
    const d = objc.MTLFXTemporalScalerDescriptor.alloc().init();
    d.setInputWidth_(Math.round(o.input[0]));
    d.setInputHeight_(Math.round(o.input[1]));
    d.setOutputWidth_(Math.round(o.output[0]));
    d.setOutputHeight_(Math.round(o.output[1]));
    d.setColorTextureFormat_(PixelFormat[o.color]);
    d.setDepthTextureFormat_(PixelFormat[o.depth]);
    d.setMotionTextureFormat_(PixelFormat[o.motion]);
    d.setOutputTextureFormat_(PixelFormat[o.outputFormat]);
    d.setAutoExposureEnabled_(!!o.autoExposure);
    if (o.dynamic) {
      d.setInputContentPropertiesEnabled_(true);
      d.setInputContentMinScale_(o.dynamic[0]);
      d.setInputContentMaxScale_(o.dynamic[1]);
    }
    if (o.reactive !== undefined) {
      if (!d.respondsTo("setReactiveMaskTextureEnabled:")) return null;
      d.setReactiveMaskTextureEnabled_(true);
      d.setReactiveMaskTextureFormat_(PixelFormat[o.reactive]);
    }
    return d;
  }

  /**
   * Build a temporal scaler, or `null` if MetalFX is missing, the scale is outside
   * {@link scaleRange}, or MetalFX refuses the configuration. Side effect: MetalFX makes its
   * pipelines — 50–90 ms on this thread on an M2 Pro, a few hundred the first time in a
   * process. Anything that keeps time on this thread uses {@link build} instead.
   */
  static create(gpu: GPU, o: TemporalScalerOptions): TemporalScaler | null {
    try {
      const d = TemporalScaler.#descriptor(gpu, o);
      if (!d) return null;
      const native = d.newTemporalScalerWithDevice_(gpu.device);
      if (!native || native.ptr === NIL) return null;
      return new TemporalScaler(native, o);
    } catch {
      return null;
    }
  }

  /**
   * Start building a temporal scaler on a background queue, and return the build to poll; or
   * `null` where {@link create} would return `null` before building anything. Side effects:
   * loads MetalFX; MetalFX makes its pipelines on another thread. Never blocks.
   */
  static build(gpu: GPU, o: TemporalScalerOptions): EffectBuild<TemporalScaler> | null {
    try {
      const d = TemporalScaler.#descriptor(gpu, o);
      if (!d) return null;
      return EffectBuild.start(gpu, d, 0, (native) => new TemporalScaler(native, o));
    } catch {
      return null;
    }
  }

  /**
   * Release the scaler now rather than when its wrapper is collected — its history and
   * pipelines are tens of megabytes the garbage collector cannot see. Idempotent; the scaler
   * must not be encoded again.
   */
  dispose(): void {
    try {
      (this.native as { dispose?: () => void }).dispose?.();
    } catch {
      // Already released.
    }
  }

  /**
   * Encode this frame's upscale into `commands` (outside any open pass). Side effects: sets the
   * scaler's inputs and encodes MetalFX's work; afterwards `inputs.output` holds the frame.
   */
  encode(commands: MTLObject, inputs: TemporalScalerInputs): void {
    const s = this.native;
    s.setColorTexture_(raw(inputs.color));
    s.setDepthTexture_(raw(inputs.depth));
    s.setMotionTexture_(raw(inputs.motion));
    s.setOutputTexture_(raw(inputs.output));
    s.setExposureTexture_(inputs.exposure ? raw(inputs.exposure) : null);
    if (this.reactive) s.setReactiveMaskTexture_(inputs.reactive ? raw(inputs.reactive) : null);
    s.setInputContentWidth_(Math.round(inputs.content?.[0] ?? this.input[0]));
    s.setInputContentHeight_(Math.round(inputs.content?.[1] ?? this.input[1]));
    s.setPreExposure_(inputs.preExposure ?? 1);
    s.setJitterOffsetX_(inputs.jitter[0]);
    s.setJitterOffsetY_(inputs.jitter[1]);
    s.setMotionVectorScaleX_(inputs.motionScale[0]);
    s.setMotionVectorScaleY_(inputs.motionScale[1]);
    s.setReset_(!!inputs.reset);
    s.setDepthReversed_(!!inputs.depthReversed);
    s.encodeToCommandBuffer_(commands);
  }
}

/** What a spatial scaler is built for. */
export interface SpatialScalerOptions {
  input: readonly [number, number];
  output: readonly [number, number];
  color: PixelFormatName;
  outputFormat: PixelFormatName;
  /** How the input's colour is encoded: `"linear"` (the default), `"srgb"` or `"perceptual"`. */
  colorProcessing?: "perceptual" | "linear" | "srgb";
}

/**
 * MetalFX's spatial upscaler: one anti-aliased frame in, a larger one out, no history. `null`
 * from {@link SpatialScaler.create} where MetalFX is missing or refuses the configuration.
 */
export class SpatialScaler {
  readonly native: MTLObject;
  readonly input: readonly [number, number];
  readonly output: readonly [number, number];
  /** The texture usages MetalFX needs the input and the output to have been made with. */
  readonly usage: { color: number; output: number };

  private constructor(native: MTLObject, o: SpatialScalerOptions) {
    this.native = native;
    this.input = [o.input[0], o.input[1]];
    this.output = [o.output[0], o.output[1]];
    this.usage = { color: Number(native.colorTextureUsage()), output: Number(native.outputTextureUsage()) };
  }

  /** Build a spatial scaler, or `null`. Side effect: MetalFX compiles its pipelines. */
  static create(gpu: GPU, o: SpatialScalerOptions): SpatialScaler | null {
    if (!metalFXAvailable(gpu)) return null;
    try {
      const D: MTLObject = tryClass("MTLFXSpatialScalerDescriptor");
      if (!D || !D.supportsDevice_(gpu.device)) return null;
      const d = D.alloc().init();
      d.setInputWidth_(Math.round(o.input[0]));
      d.setInputHeight_(Math.round(o.input[1]));
      d.setOutputWidth_(Math.round(o.output[0]));
      d.setOutputHeight_(Math.round(o.output[1]));
      d.setColorTextureFormat_(PixelFormat[o.color]);
      d.setOutputTextureFormat_(PixelFormat[o.outputFormat]);
      // MTLFXSpatialScalerColorProcessingMode: perceptual 0, linear 1, hdr 2.
      d.setColorProcessingMode_({ perceptual: 0, srgb: 0, linear: 1 }[o.colorProcessing ?? "linear"]);
      const native = d.newSpatialScalerWithDevice_(gpu.device);
      if (!native || native.ptr === NIL) return null;
      return new SpatialScaler(native, o);
    } catch {
      return null;
    }
  }

  /** Encode the upscale of `color` into `output`. Side effect: encodes MetalFX's work. */
  encode(commands: MTLObject, color: Texture | MTLObject, output: Texture | MTLObject): void {
    const s = this.native;
    s.setColorTexture_(raw(color));
    s.setOutputTexture_(raw(output));
    s.setInputContentWidth_(this.input[0]);
    s.setInputContentHeight_(this.input[1]);
    s.encodeToCommandBuffer_(commands);
  }
}

/** Builds nobody took or cancelled, freed when their wrapper is collected. */
const unfreed = new FinalizationRegistry<bigint>((job) => {
  try {
    lib.br_fx_free(job);
  } catch {
    // The library is gone with the process.
  }
});

/**
 * A MetalFX effect being built on a background queue (native/src/metalfx.m). Poll {@link state}
 * — cheap, a lock and an integer — from the thread that will use it, and {@link take} the
 * effect once it is `"ready"`; or {@link cancel} it, and an effect that lands afterwards is
 * released where it lands. The queue wakes the run loop when it is done, so a pump asleep in
 * AppKit comes round to look.
 */
export class EffectBuild<T> {
  #job: bigint | undefined;
  readonly #make: (native: MTLObject) => T;
  /** `performance.now()` when the build started. */
  readonly startedMs = performance.now();
  /** How long the build took, ms, once it has settled; `undefined` before. */
  builtMs: number | undefined;
  #taken = false;

  private constructor(job: bigint, make: (native: MTLObject) => T) {
    this.#job = job;
    this.#make = make;
    unfreed.register(this, job, this);
  }

  /**
   * Start building from `descriptor` — kind 0 a temporal scaler, 1 a frame interpolator, 2 a
   * spatial scaler — or `null` where the native side would not start one. The descriptor is
   * copied; the caller may let go of it at once. @internal
   */
  static start<T>(gpu: GPU, descriptor: MTLObject, kind: 0 | 1 | 2, make: (native: MTLObject) => T): EffectBuild<T> | null {
    const job = lib.br_fx_create(gpu.device.ptr, descriptor.ptr, kind) as bigint;
    if (!job || job === NIL) return null;
    return new EffectBuild(job, make);
  }

  /** `"building"`, `"ready"` (take it), `"failed"`, or `"done"` once taken or cancelled. */
  get state(): "building" | "ready" | "failed" | "done" {
    if (this.#job === undefined) return "done";
    const s = lib.br_fx_poll(this.#job) as number;
    if (s !== 0 && this.builtMs === undefined) this.builtMs = performance.now() - this.startedMs;
    return s === 0 ? "building" : s > 0 ? "ready" : "failed";
  }

  /**
   * The effect, once {@link state} is `"ready"` — ownership passes to the caller, who disposes
   * of it — or `null` while building, after a failure, or a second time. Frees the job once
   * settled.
   */
  take(): T | null {
    if (this.#job === undefined || this.#taken) return null;
    const state = this.state;
    if (state === "building") return null;
    const job = this.#job;
    this.#job = undefined;
    this.#taken = true;
    unfreed.unregister(this);
    let made: T | null = null;
    if (state === "ready") {
      const native = wrap(lib.br_fx_take(job) as bigint, true);
      try {
        made = native ? this.#make(native) : null;
      } catch {
        made = null;
      }
    }
    lib.br_fx_free(job);
    return made;
  }

  /** Give the build up. An effect still being made is released when it is done. Idempotent. */
  cancel(): void {
    if (this.#job === undefined) return;
    const job = this.#job;
    this.#job = undefined;
    unfreed.unregister(this);
    lib.br_fx_free(job);
  }
}

/** What a frame interpolator is built for (macOS 26). Fixed for its life. */
export interface FrameInterpolatorOptions {
  /** The depth and motion textures' size, pixels — the render size. */
  input: readonly [number, number];
  /** The colour textures' size, pixels — the picture's. */
  output: readonly [number, number];
  color: PixelFormatName;
  outputFormat: PixelFormatName;
  depth: PixelFormatName;
  motion: PixelFormatName;
}

/** One interpolated frame's inputs. */
export interface FrameInterpolatorInputs {
  /** This frame's finished picture, and the last one's. */
  color: Texture | MTLObject;
  previous: Texture | MTLObject;
  /** This frame's depth and motion (render size), as for a temporal scaler. */
  depth: Texture | MTLObject;
  motion: Texture | MTLObject;
  /** Where the frame between them goes. Private storage. */
  output: Texture | MTLObject;
  /** Input pixels of motion per unit of the motion texture's value; see the note at the top. */
  motionScale: readonly [number, number];
  /** The sub-pixel offset the frame was rendered at, input pixels. */
  jitter: readonly [number, number];
  /** Seconds between the previous frame and this one. */
  deltaTime: number;
  /** The camera's near and far planes, vertical field of view (degrees) and aspect ratio. */
  near: number;
  far: number;
  fov: number;
  aspect: number;
  /** Whether depth 0 is the far plane. MetalFX's default is that it is; a standard depth buffer is not. */
  depthReversed?: boolean;
  /** No usable previous frame: a cut. */
  reset?: boolean;
}

/**
 * MetalFX's frame interpolator (macOS 26): the frame halfway between the last picture and this
 * one, from both pictures and this frame's depth and motion. It encodes into an ordinary
 * `MTLCommandBuffer`. There is no other instant than halfway: a host that presents it does so
 * between the two, which holds every real frame back by half a frame.
 */
export class FrameInterpolator {
  readonly native: MTLObject;
  readonly input: readonly [number, number];
  readonly output: readonly [number, number];

  private constructor(native: MTLObject, o: FrameInterpolatorOptions) {
    this.native = native;
    this.input = [o.input[0], o.input[1]];
    this.output = [o.output[0], o.output[1]];
  }

  /** Whether this machine has a frame interpolator for `gpu`'s device. Side effect: loads MetalFX. */
  static available(gpu: GPU): boolean {
    if (!metalFXAvailable(gpu)) return false;
    const D: MTLObject = tryClass("MTLFXFrameInterpolatorDescriptor");
    try {
      return !!D && !!D.supportsDevice_(gpu.device);
    } catch {
      return false;
    }
  }

  /** The descriptor for `o`, or `null` without a frame interpolator here. */
  static #descriptor(gpu: GPU, o: FrameInterpolatorOptions): MTLObject | null {
    if (!FrameInterpolator.available(gpu)) return null;
    const d = objc.MTLFXFrameInterpolatorDescriptor.alloc().init();
    d.setInputWidth_(Math.round(o.input[0]));
    d.setInputHeight_(Math.round(o.input[1]));
    d.setOutputWidth_(Math.round(o.output[0]));
    d.setOutputHeight_(Math.round(o.output[1]));
    d.setColorTextureFormat_(PixelFormat[o.color]);
    d.setOutputTextureFormat_(PixelFormat[o.outputFormat]);
    d.setDepthTextureFormat_(PixelFormat[o.depth]);
    d.setMotionTextureFormat_(PixelFormat[o.motion]);
    return d;
  }

  /**
   * Build one on this thread — 250 ms on an M2 Pro the first time — or `null`. Prefer
   * {@link build}.
   */
  static create(gpu: GPU, o: FrameInterpolatorOptions): FrameInterpolator | null {
    try {
      const d = FrameInterpolator.#descriptor(gpu, o);
      if (!d) return null;
      const native = d.newFrameInterpolatorWithDevice_(gpu.device);
      if (!native || native.ptr === NIL) return null;
      return new FrameInterpolator(native, o);
    } catch {
      return null;
    }
  }

  /** Start building one on a background queue, or `null`. Never blocks. */
  static build(gpu: GPU, o: FrameInterpolatorOptions): EffectBuild<FrameInterpolator> | null {
    try {
      const d = FrameInterpolator.#descriptor(gpu, o);
      if (!d) return null;
      return EffectBuild.start(gpu, d, 1, (native) => new FrameInterpolator(native, o));
    } catch {
      return null;
    }
  }

  /**
   * Encode the frame between `inputs.previous` and `inputs.color` into `commands` (outside any
   * open pass). Side effects: sets the interpolator's inputs; afterwards `inputs.output` holds it.
   */
  encode(commands: MTLObject, inputs: FrameInterpolatorInputs): void {
    const s = this.native;
    s.setColorTexture_(raw(inputs.color));
    s.setPrevColorTexture_(raw(inputs.previous));
    s.setDepthTexture_(raw(inputs.depth));
    s.setMotionTexture_(raw(inputs.motion));
    s.setOutputTexture_(raw(inputs.output));
    s.setMotionVectorScaleX_(inputs.motionScale[0]);
    s.setMotionVectorScaleY_(inputs.motionScale[1]);
    s.setJitterOffsetX_(inputs.jitter[0]);
    s.setJitterOffsetY_(inputs.jitter[1]);
    s.setDeltaTime_(inputs.deltaTime);
    s.setNearPlane_(inputs.near);
    s.setFarPlane_(inputs.far);
    s.setFieldOfView_(inputs.fov);
    s.setAspectRatio_(inputs.aspect);
    s.setDepthReversed_(!!inputs.depthReversed);
    s.setShouldResetHistory_(!!inputs.reset);
    s.encodeToCommandBuffer_(commands);
  }

  /** Release it now. Idempotent; it must not be encoded again. */
  dispose(): void {
    try {
      (this.native as { dispose?: () => void }).dispose?.();
    } catch {
      // Already released.
    }
  }
}
