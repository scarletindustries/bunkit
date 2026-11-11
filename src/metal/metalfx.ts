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

import { objc, tryClass } from "../objc.ts";
import { NIL } from "../bridge.ts";
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
   * Build a temporal scaler, or `null` if MetalFX is missing, the scale is outside
   * {@link scaleRange}, or MetalFX refuses the configuration. Side effect: MetalFX compiles its
   * pipelines for these formats — tens of milliseconds the first time, on this thread.
   */
  static create(gpu: GPU, o: TemporalScalerOptions): TemporalScaler | null {
    const range = TemporalScaler.scaleRange(gpu);
    if (!range) return null;
    const sx = o.output[0] / Math.max(1, o.input[0]);
    const sy = o.output[1] / Math.max(1, o.input[1]);
    if (Math.min(sx, sy) < range[0] - 1e-6 || Math.max(sx, sy) > range[1] + 1e-6) return null;
    try {
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
      if (o.reactive !== undefined) {
        if (!d.respondsTo("setReactiveMaskTextureEnabled:")) return null;
        d.setReactiveMaskTextureEnabled_(true);
        d.setReactiveMaskTextureFormat_(PixelFormat[o.reactive]);
      }
      const native = d.newTemporalScalerWithDevice_(gpu.device);
      if (!native || native.ptr === NIL) return null;
      return new TemporalScaler(native, o);
    } catch {
      return null;
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
    s.setInputContentWidth_(this.input[0]);
    s.setInputContentHeight_(this.input[1]);
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
