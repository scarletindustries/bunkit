// The GPU root: everything you allocate comes from here.
//
// Shaped after WebGPU and TypeGPU, because that is what the work being ported
// onto it is written against — a device that hands out buffers, shaders,
// pipelines and textures, and a frame that encodes passes. Metal's own
// vocabulary shows through where it is more precise (MSL, not WGSL), and the
// escape hatch to raw Objective-C is one property away on every object.

import { cfunction, objc, withPool, wrap } from "../objc.ts";
import { NIL, ptr, toArrayBuffer, asPointer, cstr, lib, readCString } from "../bridge.ts";
import {
  arrayOf,
  strideOf,
  type ArrayType,
  type DataType,
  type StructType,
} from "./types.ts";
import {
  applyBindings, computeBindings, computeSetters, renderBindings,
  type BindingTable, type BindValue,
} from "./reflect.ts";
import { Effect, PingPong, RenderTarget, type EffectOptions, type RenderTargetOptions } from "./effects.ts";
import { Bloom, type BloomOptions } from "./post.ts";

export type MTLObject = any;

// ---------------------------------------------------------------------------
// Metal enums, named
// ---------------------------------------------------------------------------

export const PixelFormat = {
  bgra8unorm: 80,
  bgra8unorm_srgb: 81,
  rgba8unorm: 70,
  rgba8unorm_srgb: 71,
  rgba16float: 115,
  rgba16unorm: 110,
  rgba32float: 125,
  rgb10a2unorm: 90,
  rg11b10float: 92,
  rg8unorm: 30,
  rg16float: 65,
  rg32float: 105,
  r8unorm: 10,
  r16unorm: 20,
  r32float: 55,
  r16float: 25,
  r32uint: 53,
  rg32uint: 103,
  rgba32uint: 123,
  depth32float: 252,
  depth16unorm: 250,
} as const;
export type PixelFormatName = keyof typeof PixelFormat;

export const CompareFunction = {
  never: 0, less: 1, equal: 2, lessEqual: 3,
  greater: 4, notEqual: 5, greaterEqual: 6, always: 7,
} as const;
export type CompareName = keyof typeof CompareFunction;

const BlendFactor = {
  zero: 0, one: 1,
  srcColor: 2, oneMinusSrcColor: 3,
  srcAlpha: 4, oneMinusSrcAlpha: 5,
  dstColor: 6, oneMinusDstColor: 7,
  dstAlpha: 8, oneMinusDstAlpha: 9,
} as const;
const BlendOperation = { add: 0, subtract: 1, reverseSubtract: 2, min: 3, max: 4 } as const;

const LoadAction = { dontCare: 0, load: 1, clear: 2 } as const;
const StoreAction = { dontCare: 0, store: 1, multisampleResolve: 2 } as const;
const StorageMode = { shared: 0, managed: 1, private: 2, memoryless: 3 } as const;
const TextureUsage = { shaderRead: 1, shaderWrite: 2, renderTarget: 4 } as const;
const CullMode = { none: 0, front: 1, back: 2 } as const;
const Winding = { clockwise: 0, counterClockwise: 1 } as const;
const PrimitiveType = { point: 0, line: 1, lineStrip: 2, triangle: 3, triangleStrip: 4 } as const;
const IndexType = { uint16: 0, uint32: 1 } as const;
/** MTLPipelineOption: what reflection to ask the compiler for. */
const PipelineOption = { none: 0, argumentInfo: 1, bufferTypeInfo: 2 } as const;

/** Where a submitted command buffer has got to. Polled, never handled. */
export const CommandBufferStatus = {
  notEnqueued: 0, enqueued: 1, committed: 2, scheduled: 3, completed: 4, error: 5,
} as const;

export const MTL = {
  PixelFormat, CompareFunction, BlendFactor, BlendOperation, LoadAction, StoreAction,
  StorageMode, TextureUsage, CullMode, Winding, PrimitiveType, IndexType, CommandBufferStatus,
} as const;

// ---------------------------------------------------------------------------
// Struct helpers for Metal's anonymous structs
//
// MTLSize and friends have no name in the type encoding — MTLClearColor is
// literally "{?=dddd}" — so there is nothing for the marshaller to look up and
// they travel as raw bytes.
// ---------------------------------------------------------------------------

export const size3 = (w: number, h = 1, d = 1) =>
  new BigUint64Array([BigInt(Math.max(0, Math.round(w))), BigInt(Math.max(0, Math.round(h))), BigInt(Math.max(0, Math.round(d)))]);

export const region2d = (x: number, y: number, w: number, h: number) =>
  new BigUint64Array([BigInt(x), BigInt(y), 0n, BigInt(w), BigInt(h), 1n]);

/** An MTLRegion with depth: origin (x, y, z) and size (w, h, d). For 3D textures. */
export const region3d = (x: number, y: number, z: number, w: number, h: number, d: number) =>
  new BigUint64Array([BigInt(x), BigInt(y), BigInt(z), BigInt(w), BigInt(h), BigInt(d)]);

export const clearColor = (c: readonly number[]) =>
  new Float64Array([c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1]);

export const viewport = (x: number, y: number, w: number, h: number, near = 0, far = 1) =>
  new Float64Array([x, y, w, h, near, far]);

function outError() {
  const slot = new BigUint64Array(1);
  return {
    ptr: ptr(slot),
    message(): string | null {
      if (slot[0] === 0n) return null;
      const err = wrap(slot[0]!, false);
      return err ? String(err.localizedDescription()) : "unknown Metal error";
    },
  };
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/**
 * A buffer whose contents are a typed schema.
 *
 * Storage is `shared`, which on Apple silicon means the CPU and GPU address the
 * same memory: `write()` stores directly into what the shader will read, with
 * no staging copy and no upload step. Measured, one instance struct costs
 * 0.12us through the schema and 0.03us written straight through `floats()`,
 * against 1.2us for a draw call — which is why per-instance data belongs here
 * rather than in per-object draw calls.
 */
export class GPUBuffer<T = unknown> {
  readonly native: MTLObject;
  readonly type: DataType<T>;
  readonly byteLength: number;
  readonly label: string;
  /** The whole buffer as bytes. Writing through this bypasses the schema. */
  readonly bytes: Uint8Array;
  readonly view: DataView;

  constructor(device: MTLObject, type: DataType<T>, label = "buffer") {
    this.type = type;
    this.byteLength = Math.max(16, type.size);
    this.label = label;
    const native = device.newBufferWithLength_options_(this.byteLength, StorageMode.shared);
    if (!native || native.ptr === NIL) throw new Error(`could not allocate ${label} (${this.byteLength} bytes)`);
    native.setLabel_(label);
    this.native = native;
    const contents = native.contents() as bigint;
    this.bytes = new Uint8Array(toArrayBuffer(asPointer(contents), 0, this.byteLength));
    this.view = new DataView(this.bytes.buffer);
  }

  /** Write the whole value. */
  write(value: T): this {
    this.type.write(this.view, 0, value);
    return this;
  }

  read(): T {
    return this.type.read(this.view, 0);
  }

  /** Write one field of a struct without touching the rest. */
  writeField<K extends string>(field: K, value: unknown): this {
    const s = this.type as unknown as StructType;
    const f = s.fields?.find((x) => x.name === field);
    if (!f) throw new Error(`${this.label}: no field "${field}"`);
    f.type.write(this.view, f.offset, value as never);
    return this;
  }

  /** A float view over the buffer, for hot loops that know the layout. */
  floats(): Float32Array {
    return new Float32Array(this.bytes.buffer, this.bytes.byteOffset, this.byteLength >> 2);
  }

  dispose(): void {
    (this as { native: MTLObject }).native = null;
  }
}

/** A buffer of N elements, addressed by index. */
export class GPUArrayBuffer<T> extends GPUBuffer<readonly T[]> {
  readonly element: DataType<T>;
  readonly capacity: number;
  readonly stride: number;
  /** How many elements the next draw should use. Set it as you fill. */
  count = 0;

  constructor(device: MTLObject, type: ArrayType<T>, label = "array") {
    super(device, type, label);
    this.element = type.element;
    this.capacity = type.length;
    this.stride = type.stride;
  }

  /** Write one element. The hot path for instance data. */
  set(index: number, value: T): this {
    if (index < 0 || index >= this.capacity) {
      throw new RangeError(`${this.label}: index ${index} outside 0..${this.capacity - 1}`);
    }
    this.element.write(this.view, index * this.stride, value);
    return this;
  }

  get(index: number): T {
    return this.element.read(this.view, index * this.stride);
  }

  /** Replace the contents and set `count`. */
  fill(values: readonly T[]): this {
    const n = Math.min(values.length, this.capacity);
    for (let i = 0; i < n; i++) this.element.write(this.view, i * this.stride, values[i]!);
    this.count = n;
    return this;
  }

  /** Raw bytes for one element, when a hot loop wants to skip the schema. */
  offsetOf(index: number): number {
    return index * this.stride;
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * MSL source, with schema declarations interpolated.
 *
 *   const shader = gpu.shader(msl`
 *     ${Uniforms.declare()}
 *     vertex float4 vs(constant Uniforms &u [[buffer(0)]]) { ... }
 *   `);
 *
 * A schema interpolated directly emits its declaration, so the struct in the
 * shader is generated from the same object that packs the bytes.
 */
export function msl(strings: TemplateStringsArray, ...values: unknown[]): string {
  const emitted = new Set<string>();
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i >= values.length) continue;
    const value = values[i];
    const declarations = (value as { declarations?(): string[] })?.declarations?.();
    if (declarations) {
      // Deduplicated across the whole template, so interpolating the same
      // helper in three places compiles it once. Order is preserved, which
      // matters: MSL needs a type declared before it is used.
      const fresh = declarations.filter((d) => !emitted.has(d));
      fresh.forEach((d) => emitted.add(d));
      out += fresh.join("\n\n");
    } else {
      out += String(value);
    }
  }
  return out;
}

/**
 * A named piece of MSL that can be interpolated into a shader.
 *
 * Snippets are how a shader gets built out of parts without a preprocessor:
 * interpolate one and its dependencies come with it, deduplicated, in an order
 * the compiler will accept.
 *
 *   const glow = snippet("glow", `float glow(float d, float r) { ... }`, [smoothMin]);
 *   gpu().effect(msl`${glow} ... return float4(glow(d, 0.4)); `);
 */
export interface Snippet {
  readonly name: string;
  readonly code: string;
  declarations(): string[];
  declare(): string;
}

export function snippet(name: string, code: string, deps: readonly Snippet[] = []): Snippet {
  const self: Snippet = {
    name,
    code: code.trim(),
    declarations() {
      const out: string[] = [];
      for (const dep of deps) {
        for (const d of dep.declarations()) if (!out.includes(d)) out.push(d);
      }
      if (!out.includes(self.code)) out.push(self.code);
      return out;
    },
    declare: () => self.declarations().join("\n\n"),
  };
  return self;
}

export class Shader {
  readonly native: MTLObject;
  readonly source: string;
  readonly label: string;
  #functions = new Map<string, MTLObject>();
  #entries: { vertex: string[]; fragment: string[]; kernel: string[] } | null = null;

  /**
   * Compile `source` on this thread — or, given `library`, adopt one already compiled from it
   * (a background compile's: see `GPU.shaderAsync`). Throws the compiler's message, with the
   * offending line under it, when the source does not compile.
   */
  constructor(device: MTLObject, source: string, label = "shader", library?: MTLObject) {
    this.source = source;
    this.label = label;
    if (!library) {
      const err = outError();
      library = device.newLibraryWithSource_options_error_(source, null, err.ptr);
      if (!library || library.ptr === NIL) {
        throw new Error(formatShaderError(err.message() ?? "no message", source, label));
      }
    }
    library.setLabel_(label);
    this.native = library;
  }

  /**
   * Entry points, grouped by kind.
   *
   * This is what lets a pipeline find its own functions: a library with one
   * vertex and one fragment function does not need you to name them.
   */
  get entries(): { vertex: string[]; fragment: string[]; kernel: string[] } {
    if (!this.#entries) {
      const out = { vertex: [] as string[], fragment: [] as string[], kernel: [] as string[] };
      const names = this.native.functionNames();
      const count = Number(names?.count() ?? 0);
      for (let i = 0; i < count; i++) {
        const name = String(names.objectAtIndex_(i));
        const kind = Number(this.fn(name).functionType());
        if (kind === 1) out.vertex.push(name);
        else if (kind === 2) out.fragment.push(name);
        else if (kind === 3) out.kernel.push(name);
      }
      this.#entries = out;
    }
    return this.#entries;
  }

  /** The only entry point of a kind, or a clear error saying why not. */
  only(kind: "vertex" | "fragment" | "kernel"): string {
    const found = this.entries[kind];
    if (found.length === 1) return found[0]!;
    if (found.length === 0) throw new Error(`${this.label}: no ${kind} function to use`);
    throw new Error(
      `${this.label}: ${found.length} ${kind} functions (${found.join(", ")}) — name the one you want`,
    );
  }

  /** A named entry point. Throws naming the ones that do exist. */
  fn(name: string): MTLObject {
    let f = this.#functions.get(name);
    if (!f) {
      f = this.native.newFunctionWithName_(name);
      if (!f || f.ptr === NIL) {
        const names = this.native.functionNames();
        const n = Number(names?.count() ?? 0);
        const have = Array.from({ length: n }, (_, i) => String(names.objectAtIndex_(i)));
        throw new Error(
          `${this.label}: no entry point "${name}".` +
            (have.length ? ` Found: ${have.join(", ")}` : " The library has none."),
        );
      }
      this.#functions.set(name, f);
    }
    return f;
  }
}

/** Put the offending line under the compiler's message; MSL errors cite lines. */
function formatShaderError(message: string, source: string, label: string): string {
  const lines = source.split("\n");
  const annotated = message.replace(/program_source:(\d+):(\d+)/g, (m, l, c) => {
    const line = lines[Number(l) - 1];
    return line === undefined ? m : `${m}\n     | ${line}\n     | ${" ".repeat(Math.max(0, Number(c) - 1))}^`;
  });
  return `${label} failed to compile:\n${annotated}`;
}

// ---------------------------------------------------------------------------
// Compiling without waiting
// ---------------------------------------------------------------------------

/**
 * What a shader asked for inside {@link GPU.nonBlocking} throws when Metal has not compiled its
 * source yet: the compile has been started on Metal's threads, and the work that wanted it should
 * be tried again once {@link GPU.compiling} is back to 0. Recognise it with
 * {@link isCompilePending} — the `name` is `"CompilePending"`, and so is the start of the message.
 */
export class CompilePending extends Error {
  /** The shader's label. */
  readonly label: string;

  constructor(label: string) {
    super(`CompilePending: ${label} is compiling in the background`);
    this.name = "CompilePending";
    this.label = label;
  }
}

/**
 * Whether `value` is a {@link CompilePending} — or says it is: one caught and logged as a string
 * still reads as one. Pure.
 */
export function isCompilePending(value: unknown): boolean {
  if (value instanceof CompilePending) return true;
  return typeof value === "string" && value.includes("CompilePending: ");
}

/**
 * A compile on Metal's threads: a library or a pipeline state. Queued until there is room for it
 * (see {@link MAX_BACKGROUND_COMPILES}), then running until it settles.
 */
interface CompileJob {
  /** What it is, for messages. */
  label: string;
  /** Start it: the native job (compile.m), or 0n if it could not be started. */
  start: () => bigint;
  /** The native job once started; `undefined` while queued. Freed exactly once, when settled. */
  handle: bigint | undefined;
  /** Everyone waiting on a library through {@link GPU.shaderAsync}. */
  waiters: { resolve: (s: Shader) => void; reject: (e: Error) => void }[];
}

/** How often finished background compiles are looked for while any is running, ms. */
const COMPILE_POLL_MS = 2;

/**
 * How long a compile inside `GPU.nonBlocking` is waited for before it is put off, ms. What Metal's
 * shader cache has comes back in a fraction of this (a library or a pipeline state ≈ 0.1–0.5 ms
 * through the completion handler); a real compile takes tens to hundreds. Without it, every
 * pipeline of a warm build was a deferral and a retry.
 */
const COMPILE_GRACE_MS = 2;

/**
 * The most compiles running on Metal's threads at once; the rest wait their turn. Metal's
 * compiler takes every core it is given: twenty libraries started together (a renderer's, after
 * its shaders changed) left the thread that asked for them without a core for 20–60 ms at a time
 * while they ran — the stall this exists to avoid, by another road. With two at a time there was
 * no such gap, and the twenty took ≈ 3 s rather than ≈ 2 (on the thread itself, one after
 * another, they were ≈ 5 s of nothing else running).
 */
export const MAX_BACKGROUND_COMPILES = 2;

/** Whether a compile job has settled, checking until `ms` have passed. A queued job has not. */
function settlesWithin(job: CompileJob, ms: number): boolean {
  if (job.handle === undefined) return false;
  if (job.handle === 0n) return true;
  const until = performance.now() + ms;
  do {
    if ((lib.br_compile_poll(job.handle) as number) !== 0) return true;
  } while (performance.now() < until);
  return false;
}

// ---------------------------------------------------------------------------
// Textures and samplers
// ---------------------------------------------------------------------------

/** MTLTextureType, for the shapes a texture can take. */
const TextureType = { "1d": 0, "2d": 2, "2dArray": 3, "2dMultisample": 4, cube: 5, "3d": 7 } as const;
export type TextureTypeName = Exclude<keyof typeof TextureType, "1d" | "2dMultisample">;

export interface TextureOptions {
  width: number;
  height: number;
  /**
   * The texture's shape. Default `"2d"` (or a multisample 2D when `sampleCount > 1`).
   *
   * `"3d"` takes {@link depth} slices and is sampled as `texture3d<float>` — a volume, such as a
   * fog density field. `"2dArray"` takes {@link arrayLength} layers and is sampled as
   * `texture2d_array<float>` (or `depth2d_array<float>` for a depth format) — a stack of shadow
   * maps, say. `"cube"` is six square faces.
   */
  type?: TextureTypeName;
  /** Slices of a `"3d"` texture. Ignored otherwise. Default 1. */
  depth?: number;
  /** Layers of a `"2dArray"` texture. Ignored otherwise. Default 1. */
  arrayLength?: number;
  format?: PixelFormatName;
  usage?: Array<keyof typeof TextureUsage>;
  storage?: keyof typeof StorageMode;
  sampleCount?: number;
  /** A full mip chain, down to 1×1. Shorthand for `mipLevels` of every level. */
  mipmapped?: boolean;
  /** How many mip levels, when not the full chain. Overrides `mipmapped`. */
  mipLevels?: number;
  label?: string;
}

/** How many mip levels a full chain has for a texture of this size: down to 1×1. Pure. */
export function fullMipCount(width: number, height: number, depth = 1): number {
  return Math.floor(Math.log2(Math.max(1, width, height, depth))) + 1;
}

export class Texture {
  readonly native: MTLObject;
  readonly width: number;
  readonly height: number;
  /** Slices of a 3D texture; 1 for anything else. */
  readonly depth: number;
  /** Layers of an array texture; 1 for anything else. */
  readonly arrayLength: number;
  readonly format: number;
  readonly sampleCount: number;
  readonly mipLevels: number;
  readonly type: TextureTypeName;

  constructor(device: MTLObject, o: TextureOptions, native?: MTLObject) {
    this.width = Math.max(1, Math.round(o.width));
    this.height = Math.max(1, Math.round(o.height));
    this.type = o.type ?? "2d";
    this.depth = this.type === "3d" ? Math.max(1, Math.round(o.depth ?? 1)) : 1;
    this.arrayLength = this.type === "2dArray" ? Math.max(1, Math.round(o.arrayLength ?? 1)) : 1;
    this.format = PixelFormat[o.format ?? "bgra8unorm"];
    this.sampleCount = o.sampleCount ?? 1;
    const full = fullMipCount(this.width, this.height, this.depth);
    this.mipLevels = Math.max(1, Math.min(full, o.mipLevels ?? (o.mipmapped ? full : 1)));

    // A view made by Texture.view() wraps a texture Metal already made.
    if (native) {
      this.native = native;
      return;
    }

    const d = objc.MTLTextureDescriptor.alloc().init();
    d.setPixelFormat_(this.format);
    d.setWidth_(this.width);
    d.setHeight_(this.height);
    d.setDepth_(this.depth);
    d.setArrayLength_(this.arrayLength);
    d.setMipmapLevelCount_(this.mipLevels);
    d.setTextureType_(this.sampleCount > 1 ? TextureType["2dMultisample"] : TextureType[this.type]);
    let usage = 0;
    for (const u of o.usage ?? ["shaderRead", "renderTarget"]) usage |= TextureUsage[u];
    d.setUsage_(usage);

    // A depth or multisample target must be private; the CPU cannot see it.
    const isDepth = this.format === PixelFormat.depth32float || this.format === PixelFormat.depth16unorm;
    const storage = o.storage ?? (isDepth || this.sampleCount > 1 ? "private" : "shared");
    d.setStorageMode_(StorageMode[storage]);
    if (this.sampleCount > 1) d.setSampleCount_(this.sampleCount);
    const made = device.newTextureWithDescriptor_(d);
    if (!made || made.ptr === NIL) throw new Error(`could not create texture ${o.label ?? ""}`);
    if (o.label) made.setLabel_(o.label);
    this.native = made;
  }

  /** Bytes one pixel occupies in this format, for read() and write(). */
  get bytesPerPixel(): number {
    switch (this.format) {
      case PixelFormat.rgba32float: case PixelFormat.rgba32uint: return 16;
      case PixelFormat.rgba16float: case PixelFormat.rgba16unorm:
      case PixelFormat.rg32float: case PixelFormat.rg32uint: return 8;
      case PixelFormat.r32float: case PixelFormat.r32uint: case PixelFormat.rg16float: return 4;
      case PixelFormat.r16float: case PixelFormat.r16unorm: case PixelFormat.rg8unorm: return 2;
      case PixelFormat.r8unorm: return 1;
      default: return 4;
    }
  }

  /**
   * Upload pixels, into mip level 0 (or `options.level`). RGBA8 unless the texture says
   * otherwise.
   *
   * For a 3D texture `pixels` holds every slice, one after another, and for an array texture
   * `options.slice` picks the layer. Side effect: replaces the texture's contents in that region;
   * only valid for shared or managed storage.
   */
  write(
    pixels: ArrayBufferView,
    bytesPerRow?: number,
    options: { level?: number; slice?: number } = {},
  ): this {
    const level = options.level ?? 0;
    const w = Math.max(1, this.width >> level);
    const h = Math.max(1, this.height >> level);
    const row = bytesPerRow ?? w * this.bytesPerPixel;
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    if (this.type === "3d") {
      const d = Math.max(1, this.depth >> level);
      this.native.replaceRegion_mipmapLevel_slice_withBytes_bytesPerRow_bytesPerImage_(
        region3d(0, 0, 0, w, h, d), level, 0, ptr(bytes), row, row * h,
      );
    } else if (options.slice !== undefined) {
      this.native.replaceRegion_mipmapLevel_slice_withBytes_bytesPerRow_bytesPerImage_(
        region2d(0, 0, w, h), level, options.slice, ptr(bytes), row, row * h,
      );
    } else {
      this.native.replaceRegion_mipmapLevel_withBytes_bytesPerRow_(region2d(0, 0, w, h), level, ptr(bytes), row);
    }
    return this;
  }

  /**
   * Read the texture back. Only valid for shared storage.
   *
   * The bytes are in the texture's own format — a 16-bit float target comes
   * back as half floats, not as something you can index as RGBA8. A 3D texture comes back
   * whole, slice after slice; an array texture gives `options.slice` (default 0).
   */
  read(options: { level?: number; slice?: number } = {}): Uint8Array {
    const level = options.level ?? 0;
    const w = Math.max(1, this.width >> level);
    const h = Math.max(1, this.height >> level);
    const stride = w * this.bytesPerPixel;
    if (this.type === "3d") {
      const d = Math.max(1, this.depth >> level);
      const out = new Uint8Array(stride * h * d);
      this.native.getBytes_bytesPerRow_bytesPerImage_fromRegion_mipmapLevel_slice_(
        ptr(out), stride, stride * h, region3d(0, 0, 0, w, h, d), level, 0,
      );
      return out;
    }
    const out = new Uint8Array(stride * h);
    if (options.slice !== undefined) {
      this.native.getBytes_bytesPerRow_bytesPerImage_fromRegion_mipmapLevel_slice_(
        ptr(out), stride, stride * h, region2d(0, 0, w, h), level, options.slice,
      );
    } else {
      this.native.getBytes_bytesPerRow_fromRegion_mipmapLevel_(ptr(out), stride, region2d(0, 0, w, h), level);
    }
    return out;
  }

  /**
   * A view of part of this texture: one mip level (or a run of them), one layer of an array, or
   * the same pixels under another format of the same size.
   *
   *   const half = bloomChain.view({ level: 1 });   // write mip 1 from a kernel
   *   const layer = shadows.view({ slice: 3 });      // render into layer 3 of a 2D array
   *
   * The view shares the texture's memory — writing through it writes the texture. The texture
   * must have been made with the usage the view is used for. A single `slice` of an array or
   * cube comes back as a plain 2D texture, which is what a render pass attaches.
   */
  view(o: { level?: number; levels?: number; slice?: number; slices?: number; format?: PixelFormatName } = {}): Texture {
    const level = o.level ?? 0;
    const levels = o.levels ?? 1;
    const single = o.slice !== undefined && (o.slices ?? 1) === 1;
    const slice = o.slice ?? 0;
    const slices = o.slices ?? (o.slice !== undefined ? 1 : this.arrayLength * (this.type === "cube" ? 6 : 1));
    const type: TextureTypeName = single && (this.type === "2dArray" || this.type === "cube") ? "2d" : this.type;
    const format = o.format ? PixelFormat[o.format] : this.format;
    const native = this.native.newTextureViewWithPixelFormat_textureType_levels_slices_(
      // NSRange is a struct the bridge knows by name, so it takes the object form.
      format, TextureType[type],
      { location: level, length: levels },
      { location: slice, length: slices },
    );
    if (!native || native.ptr === NIL) throw new Error("could not make a texture view");
    const name = (Object.keys(PixelFormat) as PixelFormatName[]).find((k) => PixelFormat[k] === format);
    return new Texture(null, {
      width: Math.max(1, this.width >> level),
      height: Math.max(1, this.height >> level),
      depth: Math.max(1, this.depth >> level),
      arrayLength: type === "2dArray" ? slices : 1,
      type, format: name, mipLevels: levels, sampleCount: this.sampleCount,
    }, native);
  }
}

export interface SamplerOptions {
  filter?: "nearest" | "linear";
  mip?: "none" | "nearest" | "linear";
  /**
   * What a coordinate outside 0–1 reads. `"zero"` reads transparent black — what a shadow or a
   * projected pattern wants past its edge. Applies to every axis, including a 3D texture's `r`.
   */
  address?: "clamp" | "repeat" | "mirror" | "zero";
  /**
   * Make this a **comparison** sampler, for `depth2d::sample_compare`: each tap answers whether
   * the reference passes `compare` against the stored depth, and linear filtering blends four of
   * those answers — hardware PCF. Shadow maps want `"lessEqual"`.
   */
  compare?: CompareName;
  /** Anisotropic filtering, 1–16. Default 1 (off). */
  anisotropy?: number;
  label?: string;
}

export class Sampler {
  readonly native: MTLObject;
  constructor(device: MTLObject, o: SamplerOptions = {}) {
    const d = objc.MTLSamplerDescriptor.alloc().init();
    const filter = o.filter === "nearest" ? 0 : 1;
    d.setMinFilter_(filter);
    d.setMagFilter_(filter);
    d.setMipFilter_({ none: 0, nearest: 1, linear: 2 }[o.mip ?? "linear"]);
    // MTLSamplerAddressMode: clampToEdge 0, repeat 2, mirrorRepeat 3, clampToZero 4.
    const address = { clamp: 0, repeat: 2, mirror: 3, zero: 4 }[o.address ?? "clamp"];
    d.setSAddressMode_(address);
    d.setTAddressMode_(address);
    d.setRAddressMode_(address);
    if (o.compare) d.setCompareFunction_(CompareFunction[o.compare]);
    if (o.anisotropy && o.anisotropy > 1) d.setMaxAnisotropy_(Math.min(16, Math.round(o.anisotropy)));
    if (o.label) d.setLabel_(o.label);
    this.native = device.newSamplerStateWithDescriptor_(d);
  }
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export type BlendMode = "none" | "alpha" | "additive" | "premultiplied" | BlendSpec;

export interface BlendSpec {
  color: { src: keyof typeof BlendFactor; dst: keyof typeof BlendFactor; op?: keyof typeof BlendOperation };
  alpha?: { src: keyof typeof BlendFactor; dst: keyof typeof BlendFactor; op?: keyof typeof BlendOperation };
}

const BLEND_PRESETS: Record<string, BlendSpec> = {
  alpha: { color: { src: "srcAlpha", dst: "oneMinusSrcAlpha" }, alpha: { src: "one", dst: "oneMinusSrcAlpha" } },
  // Additive is what light does: beams and glows accumulate rather than occlude.
  additive: { color: { src: "srcAlpha", dst: "one" }, alpha: { src: "zero", dst: "one" } },
  premultiplied: { color: { src: "one", dst: "oneMinusSrcAlpha" }, alpha: { src: "one", dst: "oneMinusSrcAlpha" } },
};

/** A compiled pipeline state and the reflection it came with. */
interface PipelineState {
  native: MTLObject;
  reflection: MTLObject | null;
}

/**
 * Where a pipeline's state comes from (see `GPU.#state`): given the shader, a key for everything
 * else that decides it, a label, how to compile it here, and how to start compiling it on Metal's
 * threads (a native job, or 0). Returns the state, or throws as compiling it would — or throws
 * {@link CompilePending}.
 */
type PipelineStates = (
  shader: Shader,
  key: string,
  label: string,
  here: () => PipelineState,
  background: () => bigint,
) => PipelineState;

export interface RenderPipelineOptions {
  /** A compiled Shader, or MSL source to compile. */
  shader: Shader | string;
  /** Entry point. Omit when the library has exactly one vertex function. */
  vertex?: string;
  /** Omit when the library has exactly one fragment function. */
  fragment?: string;
  /**
   * Attachment format, or one per attachment for a shader writing several.
   *
   * A fragment function returning a struct of `[[color(0)]]`/`[[color(1)]]`
   * members needs a format for each, and they have to match the textures the
   * pass attaches or the pipeline is rejected.
   */
  format?: PixelFormatName | readonly PixelFormatName[];
  depthFormat?: PixelFormatName | null;
  blend?: BlendMode;
  depth?: { compare?: CompareName; write?: boolean } | false;
  cull?: keyof typeof CullMode;
  winding?: keyof typeof Winding;
  sampleCount?: number;
  label?: string;
}

export class RenderPipeline {
  readonly native: MTLObject;
  readonly shader: Shader;
  readonly depthState: MTLObject | null;
  readonly cull: number;
  readonly winding: number;
  readonly label: string;
  /** Every argument the shader takes, by name. See bind() on a pass. */
  readonly bindings: BindingTable;

  /**
   * Build the descriptor and compile the pipeline state — here, or (with `states`, which the GPU
   * passes) wherever it says: a state compiled in the background, or a {@link CompilePending}
   * thrown inside {@link GPU.nonBlocking}. Throws Metal's message when it does not compile.
   */
  constructor(device: MTLObject, o: RenderPipelineOptions, compile: (src: string) => Shader, states?: PipelineStates) {
    const shader = typeof o.shader === "string" ? compile(o.shader) : o.shader;
    this.shader = shader;
    const vertexName = o.vertex ?? shader.only("vertex");
    this.label = o.label ?? vertexName;

    const d = objc.MTLRenderPipelineDescriptor.alloc().init();
    d.setLabel_(this.label);
    d.setVertexFunction_(shader.fn(vertexName));
    // A fragment function is optional (depth-only passes have none), but if the
    // library has exactly one it is what you meant.
    const fragmentName = o.fragment ?? (shader.entries.fragment.length === 1 ? shader.entries.fragment[0] : undefined);
    if (fragmentName) d.setFragmentFunction_(shader.fn(fragmentName));

    const formats = Array.isArray(o.format)
      ? (o.format as readonly PixelFormatName[])
      : [(o.format as PixelFormatName) ?? "bgra8unorm"];
    const blend = typeof o.blend === "string" ? BLEND_PRESETS[o.blend] : o.blend;

    formats.forEach((name, i) => {
      const attachment = d.colorAttachments().objectAtIndexedSubscript_(i);
      attachment.setPixelFormat_(PixelFormat[name]);
      if (!blend) return;
      attachment.setBlendingEnabled_(true);
      attachment.setRgbBlendOperation_(BlendOperation[blend.color.op ?? "add"]);
      attachment.setSourceRGBBlendFactor_(BlendFactor[blend.color.src]);
      attachment.setDestinationRGBBlendFactor_(BlendFactor[blend.color.dst]);
      const a = blend.alpha ?? blend.color;
      attachment.setAlphaBlendOperation_(BlendOperation[a.op ?? "add"]);
      attachment.setSourceAlphaBlendFactor_(BlendFactor[a.src]);
      attachment.setDestinationAlphaBlendFactor_(BlendFactor[a.dst]);
    });

    const depthFormat = o.depthFormat === null ? null : (o.depthFormat ?? "depth32float");
    if (depthFormat) d.setDepthAttachmentPixelFormat_(PixelFormat[depthFormat]);
    if (o.sampleCount && o.sampleCount > 1) d.setRasterSampleCount_(o.sampleCount);

    // ArgumentInfo | BufferTypeInfo: the names and the struct layouts. Asking
    // for them costs a little compile time once and saves index bookkeeping
    // for the life of the program.
    const options = PipelineOption.argumentInfo | PipelineOption.bufferTypeInfo;
    const here = (): PipelineState => {
      const err = outError();
      const reflection = new BigUint64Array(1);
      const native = device.newRenderPipelineStateWithDescriptor_options_reflection_error_(
        d, options, ptr(reflection), err.ptr,
      );
      if (!native || native.ptr === NIL) {
        throw new Error(`pipeline ${this.label}: ${err.message() ?? "unknown error"}`);
      }
      return { native, reflection: reflection[0] ? wrap(reflection[0]!, false) : null };
    };
    // What decides the compiled state: the functions, the attachments and the blending. Cull,
    // winding and depth testing are the encoder's, set at draw time.
    const key = `render|${vertexName}|${fragmentName ?? ""}|${formats.join(",")}|${depthFormat ?? ""}|${JSON.stringify(blend ?? null)}|${o.sampleCount ?? 1}`;
    const state = states
      ? states(shader, key, this.label, here, () => lib.br_render_pipeline_compile(device.ptr, d.ptr, BigInt(options)) as bigint)
      : here();
    this.native = state.native;
    this.bindings = renderBindings(state.reflection);

    if (o.depth === false || !depthFormat) {
      this.depthState = null;
    } else {
      const dd = objc.MTLDepthStencilDescriptor.alloc().init();
      dd.setDepthCompareFunction_(CompareFunction[o.depth?.compare ?? "less"]);
      dd.setDepthWriteEnabled_(o.depth?.write ?? true);
      this.depthState = device.newDepthStencilStateWithDescriptor_(dd);
    }
    this.cull = CullMode[o.cull ?? "back"];
    this.winding = Winding[o.winding ?? "counterClockwise"];
  }
}

export interface ComputePipelineOptions {
  shader: Shader | string;
  /** Omit when the library has exactly one kernel. */
  entry?: string;
  label?: string;
}

export class ComputePipeline {
  readonly native: MTLObject;
  readonly shader: Shader;
  readonly label: string;
  /** Widest threadgroup this kernel supports; dispatch() uses it by default. */
  readonly maxThreads: number;
  readonly threadExecutionWidth: number;
  readonly bindings: BindingTable;
  #gpu: GPU;

  /**
   * Compile the kernel's pipeline state — here, or (with `states`, which the GPU passes) wherever
   * it says: a state compiled in the background, or a {@link CompilePending} thrown inside
   * {@link GPU.nonBlocking}. Throws Metal's message when it does not compile.
   */
  constructor(gpu: GPU, o: ComputePipelineOptions, compile: (src: string) => Shader, states?: PipelineStates) {
    const device = gpu.device;
    this.#gpu = gpu;
    const shader = typeof o.shader === "string" ? compile(o.shader) : o.shader;
    this.shader = shader;
    const entry = o.entry ?? shader.only("kernel");
    this.label = o.label ?? entry;

    const options = PipelineOption.argumentInfo | PipelineOption.bufferTypeInfo;
    const fn = shader.fn(entry);
    const here = (): PipelineState => {
      const err = outError();
      const reflection = new BigUint64Array(1);
      const native = device.newComputePipelineStateWithFunction_options_reflection_error_(
        fn, options, ptr(reflection), err.ptr,
      );
      if (!native || native.ptr === NIL) {
        throw new Error(`compute pipeline ${this.label}: ${err.message() ?? "unknown error"}`);
      }
      return { native, reflection: reflection[0] ? wrap(reflection[0]!, false) : null };
    };
    const state = states
      ? states(shader, `compute|${entry}`, this.label, here, () => lib.br_compute_pipeline_compile(device.ptr, fn.ptr, BigInt(options)) as bigint)
      : here();
    const native = state.native;
    this.native = native;
    this.bindings = computeBindings(state.reflection);
    this.maxThreads = Number(native.maxTotalThreadsPerThreadgroup());
    this.threadExecutionWidth = Number(native.threadExecutionWidth());
  }

  /**
   * Run the kernel over `items` threads and wait for it.
   *
   *   const step = gpu().kernel(source);
   *   step.run(particles.count, { particles, dt: 1 / 60 });
   *
   * For work that belongs to a frame, use frame.dispatch() instead — that
   * shares one command buffer with the rendering rather than blocking on its
   * own. This one is for setup, for tests, and for one-off batches.
   */
  run(items: number, bind: Record<string, BindValue> = {}): this {
    this.#gpu.submit((commands) => {
      const encoder = commands.computeCommandEncoder();
      encoder.setLabel_(this.label);
      encoder.setComputePipelineState_(this.native);
      applyBindings(bind, this.bindings, this.label, computeSetters(encoder));
      const width = Math.min(Math.max(1, items), this.maxThreads);
      encoder.dispatchThreadgroups_threadsPerThreadgroup_(
        size3(Math.ceil(items / width)), size3(width),
      );
      encoder.endEncoding();
    });
    return this;
  }
}

export interface GPUInfo {
  name: string;
  unifiedMemory: boolean;
  maxThreadgroupSize: number;
  supportsFamilyApple7: boolean;
}

export class GPU {
  readonly device: MTLObject;
  readonly queue: MTLObject;
  #shaders = new Map<string, Shader>();
  #linear: Sampler | null = null;
  #nearest: Sampler | null = null;

  constructor(device: MTLObject) {
    this.device = device;
    this.queue = device.newCommandQueue();
    this.queue.setLabel_("bunkit");
  }

  get info(): GPUInfo {
    return {
      name: String(this.device.name()),
      unifiedMemory: !!this.device.hasUnifiedMemory(),
      maxThreadgroupSize: Number(this.device.maxThreadsPerThreadgroup?.()?.[0] ?? 1024),
      supportsFamilyApple7: !!this.device.supportsFamily_(1007),
    };
  }

  /** A buffer holding one value of a schema. */
  buffer<T>(type: DataType<T>, options: { label?: string } = {}): GPUBuffer<T> {
    return new GPUBuffer(this.device, type, options.label);
  }

  /** A buffer holding `count` elements of a schema, addressed by index. */
  array<T>(element: DataType<T>, count: number, options: { label?: string } = {}): GPUArrayBuffer<T> {
    return new GPUArrayBuffer(this.device, arrayOf(element, count), options.label);
  }

  /** A buffer initialised from existing typed-array data (geometry, indices). */
  data(source: ArrayBufferView, options: { label?: string } = {}): MTLObject {
    const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    const buf = this.device.newBufferWithBytes_length_options_(
      ptr(bytes), Math.max(4, bytes.byteLength), StorageMode.shared,
    );
    if (options.label) buf.setLabel_(options.label);
    return buf;
  }

  /**
   * Compile MSL. Identical source is compiled once.
   *
   * On this thread, and it waits: a source Metal's shader cache has seen is a fraction of a
   * millisecond, one it has not — the first run after the source changed — can be hundreds. Inside
   * {@link nonBlocking}, a source not compiled yet is started on Metal's threads instead and this
   * throws {@link CompilePending}. A source whose background compile failed throws its compile
   * error, as compiling it here would.
   */
  shader(source: string, options: { label?: string; cache?: boolean } = {}): Shader {
    if (options.cache === false) return new Shader(this.device, source, options.label);
    let s = this.#shaders.get(source);
    if (s) return s;
    if (this.#jobs.size > 0) {
      this.#poll();
      s = this.#shaders.get(source);
      if (s) return s;
    }
    const failed = this.#failed.get(source);
    if (failed !== undefined) throw new Error(formatShaderError(failed, source, options.label ?? "shader"));
    if (this.#nonBlocking > 0) {
      // Metal answers a source its cache has seen in well under a millisecond: wait that long
      // for it, so only a real compile is put off.
      const job = this.#start(source, options.label ?? "shader");
      if (settlesWithin(job, this.#grace())) {
        this.#poll();
        s = this.#shaders.get(source);
        if (s) return s;
        const failedNow = this.#failed.get(source);
        if (failedNow !== undefined) throw new Error(formatShaderError(failedNow, source, options.label ?? "shader"));
      }
      this.#deferred++;
      this.#scopeDeferred = true;
      throw new CompilePending(options.label ?? "shader");
    }
    // A background compile of this source may be under way; compiling it here is still right —
    // what it finishes with is dropped (see #poll), and the caller is not kept waiting on a poll.
    s = new Shader(this.device, source, options.label);
    this.#shaders.set(source, s);
    return s;
  }

  /** Background library compiles under way, by source. */
  readonly #jobs = new Map<string, CompileJob>();
  /** Sources whose background compile failed, and the compiler's message. */
  readonly #failed = new Map<string, string>();
  /** Background pipeline-state compiles under way, by {@link #stateKey}. */
  readonly #stateJobs = new Map<string, CompileJob>();
  /** Compiles waiting for room to start, oldest first, and how many are running. */
  readonly #queue: CompileJob[] = [];
  #running = 0;
  /**
   * Pipeline states compiled in the background, by {@link #stateKey}: what a pipeline asked for
   * again, once one is ready, is made from. Kept for the GPU's life — a state is a few hundred
   * bytes, and the same pipeline asked for again (a renderer rebuilt) is made at once.
   */
  readonly #states_ = new Map<string, PipelineState>();
  /** Pipeline states whose background compile failed, and Metal's message. */
  readonly #stateFailed = new Map<string, string>();
  /** Depth of {@link nonBlocking} calls on the stack. */
  #nonBlocking = 0;
  /** Compiles {@link nonBlocking} has deferred, ever. */
  #deferred = 0;
  /** The poll timer, while any compile is running. */
  #pollTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Compile MSL on Metal's threads, and resolve with the {@link Shader} — the same object
   * {@link shader} returns for this source from then on. Already compiled, it resolves at once;
   * already compiling, it joins that compile. Rejects with the compiler's message if the source
   * does not compile.
   *
   * Side effects: starts the compile and, while any is running, polls for it every couple of
   * milliseconds on this thread (a pump blocked in AppKit is woken when one finishes). Nothing
   * runs on another thread but Metal's compiler.
   */
  shaderAsync(source: string, options: { label?: string } = {}): Promise<Shader> {
    const ready = this.#shaders.get(source);
    if (ready) return Promise.resolve(ready);
    const failed = this.#failed.get(source);
    if (failed !== undefined) return Promise.reject(new Error(formatShaderError(failed, source, options.label ?? "shader")));
    return new Promise((resolve, reject) => {
      this.#start(source, options.label ?? "shader").waiters.push({ resolve, reject });
    });
  }

  /**
   * Run `fn`, and have anything it compiles that Metal has not compiled yet — a shader library
   * ({@link shader}) or a pipeline's state ({@link renderPipeline}, {@link computePipeline}) — start
   * compiling on Metal's threads and throw {@link CompilePending}, rather than compile on this
   * thread. For work that can be put off and tried again: building a renderer a stage at a time
   * between the frames of a window, on a thread that has a clock to keep. Nests. Returns what
   * `fn` returns.
   *
   * Side effects: as {@link shader} inside it; counts every deferral in {@link deferred}, so
   * work that caught a {@link CompilePending} itself and carried on can be told from work that
   * did not need to wait.
   */
  nonBlocking<T>(fn: () => T): T {
    if (this.#nonBlocking === 0) this.#scopeDeferred = false;
    this.#nonBlocking++;
    try {
      return fn();
    } finally {
      this.#nonBlocking--;
    }
  }

  /** Whether the outermost {@link nonBlocking} running now has put a compile off already. */
  #scopeDeferred = false;

  /**
   * How long to wait for a compile inside {@link nonBlocking} before putting it off: the grace,
   * unless this scope has put one off already — the work will be tried again whatever happens,
   * so a wait for a second compile is time spent for nothing.
   */
  #grace(): number {
    return this.#scopeDeferred ? 0 : COMPILE_GRACE_MS;
  }

  /**
   * How many libraries and pipeline states are compiling in the background now. Reading it
   * collects the ones that have finished, so polling it is how a caller waits without blocking.
   */
  get compiling(): number {
    if (this.#jobs.size + this.#stateJobs.size > 0) this.#poll();
    return this.#jobs.size + this.#stateJobs.size;
  }

  /** How many compiles {@link nonBlocking} has deferred since this GPU was made. */
  get deferred(): number {
    return this.#deferred;
  }

  /** Compile `source` in the background (when there is room), or join the compile already asked for. */
  #start(source: string, label: string): CompileJob {
    let job = this.#jobs.get(source);
    if (job) return job;
    const device = this.device.ptr;
    job = { label, waiters: [], handle: undefined, start: () => lib.br_library_compile(device, ptr(cstr(source))) as bigint };
    this.#jobs.set(source, job);
    this.#launch(job);
    return job;
  }

  /** Start `job` now if fewer than {@link MAX_BACKGROUND_COMPILES} are running, else queue it. */
  #launch(job: CompileJob): void {
    if (this.#running < MAX_BACKGROUND_COMPILES) {
      job.handle = job.start();
      this.#running++;
    } else {
      this.#queue.push(job);
    }
    this.#schedulePoll();
  }

  /** Shaders' numbers, for keying pipeline states by the library they come from. */
  readonly #shaderIds = new WeakMap<Shader, number>();
  #nextShaderId = 1;

  /** A pipeline state's key: the shader it comes from and everything else that decides it. */
  #stateKey(shader: Shader, key: string): string {
    let id = this.#shaderIds.get(shader);
    if (id === undefined) {
      id = this.#nextShaderId++;
      this.#shaderIds.set(shader, id);
    }
    return `${id}|${key}`;
  }

  /**
   * Where every pipeline this GPU makes gets its state (see `PipelineStates`): one compiled in the
   * background if there is one; inside {@link nonBlocking}, a background compile started (or
   * joined) and {@link CompilePending} thrown; otherwise compiled here, as always.
   */
  readonly #states: PipelineStates = (shader, key, label, here, background) => {
    const full = this.#stateKey(shader, key);
    if (this.#stateJobs.size > 0) this.#poll();
    const ready = this.#states_.get(full);
    if (ready) return ready;
    const failed = this.#stateFailed.get(full);
    if (failed !== undefined) throw new Error(`pipeline ${label}: ${failed}`);
    if (this.#nonBlocking === 0) return here();
    let job = this.#stateJobs.get(full);
    if (!job) {
      job = { label, waiters: [], handle: undefined, start: background };
      this.#stateJobs.set(full, job);
      this.#launch(job);
    }
    // As for a library: what Metal's cache has is back in well under a millisecond.
    if (settlesWithin(job, this.#grace())) {
      this.#poll();
      const now = this.#states_.get(full);
      if (now) return now;
      const failedNow = this.#stateFailed.get(full);
      if (failedNow !== undefined) throw new Error(`pipeline ${label}: ${failedNow}`);
    }
    this.#deferred++;
    this.#scopeDeferred = true;
    throw new CompilePending(label);
  };

  /** Keep polling while anything compiles. */
  #schedulePoll(): void {
    if (this.#pollTimer !== undefined || this.#jobs.size + this.#stateJobs.size === 0) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      this.#poll();
      this.#schedulePoll();
    }, COMPILE_POLL_MS);
  }

  /**
   * Settle every background compile that has finished: a library goes into the shader cache
   * (unless one was compiled meanwhile) and a pipeline state into {@link #states_}; a failure is
   * remembered, to be thrown as compiling it here would have; waiters are told. Then start what
   * was queued, as there is room. Never throws.
   */
  #poll(): void {
    for (const [source, job] of this.#jobs) {
      const state = this.#settled(job);
      if (state === 0) continue;
      this.#jobs.delete(source);
      if (state === 1) {
        const library = wrap(lib.br_compile_take(job.handle!) as bigint, true);
        let shader = this.#shaders.get(source);
        if (!shader && library) {
          shader = new Shader(this.device, source, job.label, library);
          this.#shaders.set(source, shader);
          this.#prefetchKernels(shader);
        }
        if (shader) for (const w of job.waiters) w.resolve(shader);
        else for (const w of job.waiters) w.reject(new Error(`${job.label}: the compiled library was empty`));
      } else {
        const message = job.handle === 0n
          ? "the compile could not be started"
          : readCString(lib.br_compile_error(job.handle!) as bigint) || "no message";
        this.#failed.set(source, message);
        for (const w of job.waiters) w.reject(new Error(formatShaderError(message, source, job.label)));
      }
      this.#finish(job);
    }
    for (const [key, job] of this.#stateJobs) {
      const state = this.#settled(job);
      if (state === 0) continue;
      this.#stateJobs.delete(key);
      if (state === 1) {
        const native = wrap(lib.br_compile_take(job.handle!) as bigint, true);
        const reflection = wrap(lib.br_compile_take_reflection(job.handle!) as bigint, true);
        if (native) this.#states_.set(key, { native, reflection });
        else this.#stateFailed.set(key, "the compiled state was empty");
      } else {
        this.#stateFailed.set(key, job.handle === 0n
          ? "the compile could not be started"
          : readCString(lib.br_compile_error(job.handle!) as bigint) || "unknown error");
      }
      this.#finish(job);
    }
    while (this.#running < MAX_BACKGROUND_COMPILES && this.#queue.length > 0) {
      const next = this.#queue.shift()!;
      next.handle = next.start();
      this.#running++;
    }
  }

  /**
   * Start compiling, in the background, the pipeline state of every kernel in a library that has
   * just been compiled in the background. A compute pipeline's state depends on nothing but its
   * function, so it can be had before anyone asks — and after a shader changes, its states are as
   * new to Metal as its library: one asked for at a time, a library of twelve kernels was twelve
   * deferrals and a build tried thirteen times. Render pipelines depend on the attachments they
   * draw to and wait to be asked. Never throws.
   */
  #prefetchKernels(shader: Shader): void {
    try {
      const device = this.device.ptr;
      for (const entry of shader.entries.kernel) {
        const key = this.#stateKey(shader, `compute|${entry}`);
        if (this.#states_.has(key) || this.#stateJobs.has(key) || this.#stateFailed.has(key)) continue;
        const fn = shader.fn(entry);
        const options = BigInt(PipelineOption.argumentInfo | PipelineOption.bufferTypeInfo);
        const job: CompileJob = {
          label: entry, waiters: [], handle: undefined,
          start: () => lib.br_compute_pipeline_compile(device, fn.ptr, options) as bigint,
        };
        this.#stateJobs.set(key, job);
        this.#launch(job);
      }
    } catch {
      // A library whose functions cannot be listed is compiled as it is asked for instead.
    }
  }

  /** A job's state: 0 queued or compiling, 1 compiled, -1 failed (or never started). */
  #settled(job: CompileJob): number {
    if (job.handle === undefined) return 0;
    if (job.handle === 0n) return -1;
    return lib.br_compile_poll(job.handle) as number;
  }

  /** A settled job: free its native half and make room for the next. */
  #finish(job: CompileJob): void {
    if (job.handle !== undefined && job.handle !== 0n) lib.br_compile_free(job.handle);
    this.#running--;
  }

  /**
   * A render pipeline. Its source is compiled through {@link shader} and its state here, or —
   * inside {@link nonBlocking} — on Metal's threads, throwing {@link CompilePending} until it is.
   */
  renderPipeline(o: RenderPipelineOptions): RenderPipeline {
    return new RenderPipeline(this.device, o, (src) => this.shader(src, { label: o.label }), this.#states);
  }

  /** A compute pipeline; compiled as {@link renderPipeline} is. */
  computePipeline(o: ComputePipelineOptions): ComputePipeline {
    return new ComputePipeline(this, o, (src) => this.shader(src, { label: o.label }), this.#states);
  }

  /**
   * A compute kernel from MSL. The entry point is found for you.
   *
   *   const step = gpu().kernel(msl`
   *     ${Particle}
   *     kernel void step(device Particle *p [[buffer(0)]],
   *                      constant float &dt [[buffer(1)]],
   *                      uint i [[thread_position_in_grid]]) { ... }
   *   `);
   */
  kernel(source: string | ComputePipelineOptions, label?: string): ComputePipeline {
    return this.computePipeline(typeof source === "string" ? { shader: source, label } : source);
  }

  texture(o: TextureOptions): Texture {
    return new Texture(this.device, o);
  }

  sampler(o: SamplerOptions = {}): Sampler {
    return new Sampler(this.device, o);
  }

  /**
   * Load an image file into a texture. Anything AppKit reads: PNG, JPEG, HEIC.
   *
   * The file is redrawn into a known RGBA8 layout rather than trusted as it
   * came, because an image on disk can be greyscale, indexed, 16 bits per
   * channel or premultiplied, and uploading those bytes as if they were RGBA8
   * gives you a texture that is wrong in a different way for each file.
   */
  loadTexture(path: string, o: { label?: string; mipmapped?: boolean } = {}): Texture {
    return withPool(() => {
      const image = objc.NSImage.alloc().initWithContentsOfFile_(path);
      if (!image || image.ptr === NIL) throw new Error(`could not read an image from ${path}`);
      const size = image.size();
      const width = Math.max(1, Math.round(size.width));
      const height = Math.max(1, Math.round(size.height));

      // Our own buffer: a rep created with NULL planes does not allocate, and
      // bitmapData comes back nil.
      const pixels = new Uint8Array(width * height * 4);
      const planes = new BigUint64Array([BigInt(ptr(pixels))]);
      const rep = objc.NSBitmapImageRep.alloc()
        .initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
          ptr(planes), width, height, 8, 4, true, false, "NSDeviceRGBColorSpace", width * 4, 32,
        );
      if (!rep || rep.ptr === NIL) throw new Error(`could not make a bitmap for ${path}`);

      const context = objc.NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep);
      objc.NSGraphicsContext.saveGraphicsState();
      objc.NSGraphicsContext.setCurrentContext_(context);
      image.drawInRect_({ x: 0, y: 0, width, height });
      objc.NSGraphicsContext.restoreGraphicsState();

      // Row 0 is the top, which is the origin Metal samples from, so there is
      // no flip here. If you need the other convention, do `1.0 - uv.y` in the
      // shader rather than rewriting the bitmap.

      const texture = new Texture(this.device, {
        width, height, format: "rgba8unorm", usage: ["shaderRead"],
        storage: "shared", mipmapped: o.mipmapped, label: o.label ?? path,
      });
      return texture.write(pixels);
    });
  }

  /** Linear, clamped. What a full-screen pass wants, so effects bind it for you. */
  get linearSampler(): Sampler {
    return (this.#linear ??= this.sampler({ filter: "linear", address: "clamp", label: "linear" }));
  }

  /** Nearest, clamped. For reading a texture as data rather than as an image. */
  get nearestSampler(): Sampler {
    return (this.#nearest ??= this.sampler({ filter: "nearest", mip: "nearest", address: "clamp", label: "nearest" }));
  }

  /**
   * A full-screen effect from a fragment body or a whole fragment function.
   *
   *   const grade = gpu().effect(`
   *     float3 c = src.sample(smp, uv).rgb;
   *     return float4(pow(c, float3(1.0 / 2.2)), 1.0);
   *   `);
   */
  effect(o: EffectOptions | string): Effect {
    return new Effect(this, o);
  }

  /** A texture to render into, with an optional depth buffer. */
  target(o: RenderTargetOptions): RenderTarget {
    return new RenderTarget(this, o);
  }

  /** Two targets to alternate between, for separable blurs and feedback. */
  pingPong(o: RenderTargetOptions): PingPong {
    return new PingPong(this, o);
  }

  /** An HDR scene buffer with a bloom chain and a tone mapper on the end. */
  bloom(o: BloomOptions = {}): Bloom {
    return new Bloom(this, o);
  }

  /** Run work with no view attached: compute, or rendering to a texture. */
  submit<T>(fn: (commands: MTLObject) => T, options: { wait?: boolean } = {}): T {
    return withPool(() => {
      const commands = this.queue.commandBuffer();
      const result = fn(commands);
      commands.commit();
      if (options.wait !== false) commands.waitUntilCompleted();
      const err = commands.error();
      if (err && err.ptr !== NIL) {
        throw new Error(`GPU work failed: ${String(err.localizedDescription())}`);
      }
      return result;
    });
  }
}

let root: GPU | null | undefined;

/** The process-wide GPU. Null where the machine has no Metal device. */
export function gpu(): GPU {
  const g = tryGPU();
  if (!g) throw new Error("no Metal device on this machine");
  return g;
}

export function tryGPU(): GPU | null {
  if (root === undefined) {
    const create = cfunction("MTLCreateSystemDefaultDevice", "@");
    const device = create?.();
    root = device ? new GPU(device) : null;
  }
  return root;
}

export function gpuAvailable(): boolean {
  return tryGPU() !== null;
}
