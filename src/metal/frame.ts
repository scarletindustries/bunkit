// Encoding a frame: render passes, compute passes, and the bindings they take.
//
// The shape is WebGPU's — set a pipeline, bind buffers by index, draw — because
// that is what a port arrives already written against. Every call is one or two
// Objective-C messages; a draw with its bindings costs about 1.2 microseconds
// from JavaScript, measured, which is the number that decides how a scene
// should be structured. Twenty thousand individual draws is 25 ms and will not
// fit in a frame. One instanced draw of twenty thousand objects is 1.2 us, and
// filling their instance buffer is another 2 ms.

import { isObjC, nativeOf, objc } from "../objc.ts";
import { NIL, ptr } from "../bridge.ts";
import {
  clearColor,
  MTL,
  PixelFormat,
  size3,
  viewport as makeViewport,
  type ComputePipeline,
  type GPUArrayBuffer,
  type GPUBuffer,
  type MTLObject,
  type RenderPipeline,
  type Texture,
  type Sampler,
} from "./gpu.ts";
import { gpu } from "./gpu.ts";
import { applyBindings, computeSetters, type BindingSetters, type BindValue } from "./reflect.ts";
import type { Effect, EffectPassOptions, RenderTarget } from "./effects.ts";

/** Anywhere a texture is wanted, a RenderTarget stands in for its colour. */
type TextureLike = Texture | RenderTarget | MTLObject;

function attachment(t: TextureLike): MTLObject {
  // isObjC first: reading .color off a raw MTLTexture proxy would hand back a
  // method closure rather than undefined, and bind it as a block.
  if (isObjC(t)) return t;
  const color = (t as { color?: Texture })?.color;
  return nativeOf((color ?? t) as MTLObject);
}

/** Anything that can be bound to a buffer slot. */
export type Bindable = GPUBuffer<any> | GPUArrayBuffer<any> | MTLObject;

function nativeBuffer(b: Bindable): MTLObject {
  return nativeOf(b);
}

export interface ColorAttachment {
  texture: TextureLike;
  clear?: readonly number[] | false;
  /** Multisample resolve target. Set when the attachment is multisampled. */
  resolve?: TextureLike;
  store?: boolean;
  /** Which mip level to render into. Default 0. */
  level?: number;
  /** Which layer of an array (or face of a cube) to render into. Default 0. */
  slice?: number;
  /** Which slice of a 3D texture to render into. Default 0. */
  depthPlane?: number;
}

export interface RenderPassOptions {
  /** Colour and depth from one RenderTarget. Shorthand for the two below. */
  target?: RenderTarget;
  color?: ColorAttachment | ColorAttachment[];
  depth?: TextureLike | null;
  clearDepth?: number;
  /**
   * Keep the depth buffer after the pass, so a later one can sample it.
   *
   * Off by default: nothing usually reads depth once the pass is over, and
   * discarding it saves writing it back to memory.
   */
  storeDepth?: boolean;
  /**
   * Keep what the depth attachment already holds instead of clearing it — for a pass that draws
   * over an earlier one's depth (lighting volumes, transparent surfaces after an opaque pass).
   */
  loadDepth?: boolean;
  /** Which layer of an array depth texture to render into. Default 0. */
  depthSlice?: number;
  /** Clear colour, when `target` is used instead of an explicit attachment. */
  clear?: readonly number[] | false;
  label?: string;
}

// ---------------------------------------------------------------------------
// Render pass
// ---------------------------------------------------------------------------

export class RenderPass {
  readonly native: MTLObject;
  #pipeline: RenderPipeline | null = null;
  #draws = 0;

  constructor(commands: MTLObject, o: RenderPassOptions) {
    const descriptor = objc.MTLRenderPassDescriptor.renderPassDescriptor();
    const colors: ColorAttachment[] =
      o.color ? (Array.isArray(o.color) ? o.color : [o.color])
      : o.target ? [{ texture: o.target.color, clear: o.clear, resolve: o.target.resolve ?? undefined }]
      : [];
    const depth = o.depth ?? o.target?.depth ?? null;

    colors.forEach((c, i) => {
      const a = descriptor.colorAttachments().objectAtIndexedSubscript_(i);
      a.setTexture_(attachment(c.texture));
      if (c.level) a.setLevel_(c.level);
      if (c.slice) a.setSlice_(c.slice);
      if (c.depthPlane) a.setDepthPlane_(c.depthPlane);
      if (c.clear === false) {
        a.setLoadAction_(MTL.LoadAction.load);
      } else {
        a.setLoadAction_(MTL.LoadAction.clear);
        a.setClearColor_(clearColor(c.clear ?? [0, 0, 0, 1]));
      }
      if (c.resolve) {
        a.setResolveTexture_(attachment(c.resolve));
        a.setStoreAction_(MTL.StoreAction.multisampleResolve);
      } else {
        a.setStoreAction_(c.store === false ? MTL.StoreAction.dontCare : MTL.StoreAction.store);
      }
    });

    if (depth) {
      const d = descriptor.depthAttachment();
      d.setTexture_(attachment(depth));
      if (o.depthSlice) d.setSlice_(o.depthSlice);
      d.setLoadAction_(o.loadDepth ? MTL.LoadAction.load : MTL.LoadAction.clear);
      d.setStoreAction_(o.storeDepth ? MTL.StoreAction.store : MTL.StoreAction.dontCare);
      d.setClearDepth_(o.clearDepth ?? 1);
    }

    const encoder = commands.renderCommandEncoderWithDescriptor_(descriptor);
    if (!encoder || encoder.ptr === NIL) {
      throw new Error(
        "could not open a render pass. Every attachment texture needs " +
          "usage: [\"renderTarget\"], and a depth attachment must be a depth format.",
      );
    }
    if (o.label) encoder.setLabel_(o.label);
    this.native = encoder;
  }

  pipeline(p: RenderPipeline): this {
    this.native.setRenderPipelineState_(p.native);
    if (p.depthState) this.native.setDepthStencilState_(p.depthState);
    this.native.setCullMode_(p.cull);
    this.native.setFrontFacingWinding_(p.winding);
    this.#pipeline = p;
    return this;
  }

  /**
   * Bind by the names the shader uses.
   *
   *   pass.pipeline(pipe).bind({
   *     globals: { viewProjection, time },   // packed into the shader's struct
   *     instances: instanceBuffer,           // bound by reference
   *     albedo: texture,
   *     smp: sampler,
   *   });
   *
   * Indices come from the compiled pipeline, so there are none to keep in sync.
   * Call it after pipeline(), which is where the names come from.
   */
  bind(values: Record<string, BindValue>): this {
    if (!this.#pipeline) throw new Error("bind() before pipeline(): the names come from the pipeline");
    const encoder = this.native;
    const setters: BindingSetters = {
      buffer: (stage, index, buffer, offset) => {
        if (stage === "vertex") encoder.setVertexBuffer_offset_atIndex_(buffer, offset, index);
        else encoder.setFragmentBuffer_offset_atIndex_(buffer, offset, index);
      },
      bytes: (stage, index, data) => {
        if (stage === "vertex") encoder.setVertexBytes_length_atIndex_(ptr(data as never), data.byteLength, index);
        else encoder.setFragmentBytes_length_atIndex_(ptr(data as never), data.byteLength, index);
      },
      texture: (stage, index, texture) => {
        if (stage === "vertex") encoder.setVertexTexture_atIndex_(texture, index);
        else encoder.setFragmentTexture_atIndex_(texture, index);
      },
      sampler: (stage, index, sampler) => {
        if (stage === "vertex") encoder.setVertexSamplerState_atIndex_(sampler, index);
        else encoder.setFragmentSamplerState_atIndex_(sampler, index);
      },
    };
    applyBindings(values, this.#pipeline.bindings, this.#pipeline.label, setters);
    return this;
  }

  /** Bind a buffer the vertex stage reads, at `[[buffer(index)]]`. */
  vertex(index: number, buffer: Bindable, offset = 0): this {
    this.native.setVertexBuffer_offset_atIndex_(nativeBuffer(buffer), offset, index);
    return this;
  }

  /** Bind a buffer the fragment stage reads. */
  fragment(index: number, buffer: Bindable, offset = 0): this {
    this.native.setFragmentBuffer_offset_atIndex_(nativeBuffer(buffer), offset, index);
    return this;
  }

  /** Bind the same buffer to both stages, which uniforms usually want. */
  uniforms(index: number, buffer: Bindable, offset = 0): this {
    return this.vertex(index, buffer, offset).fragment(index, buffer, offset);
  }

  /** Inline bytes, for data too small to deserve a buffer. Max 4 KB. */
  vertexBytes(index: number, data: ArrayBufferView): this {
    this.native.setVertexBytes_length_atIndex_(ptr(data as never), data.byteLength, index);
    return this;
  }

  fragmentBytes(index: number, data: ArrayBufferView): this {
    this.native.setFragmentBytes_length_atIndex_(ptr(data as never), data.byteLength, index);
    return this;
  }

  texture(index: number, t: TextureLike, stage: "fragment" | "vertex" = "fragment"): this {
    const native = attachment(t);
    if (stage === "vertex") this.native.setVertexTexture_atIndex_(native, index);
    else this.native.setFragmentTexture_atIndex_(native, index);
    return this;
  }

  sampler(index: number, s: Sampler | MTLObject, stage: "fragment" | "vertex" = "fragment"): this {
    const native = nativeOf(s);
    if (stage === "vertex") this.native.setVertexSamplerState_atIndex_(native, index);
    else this.native.setFragmentSamplerState_atIndex_(native, index);
    return this;
  }

  viewport(x: number, y: number, width: number, height: number, near = 0, far = 1): this {
    this.native.setViewport_(makeViewport(x, y, width, height, near, far));
    return this;
  }

  /** Draw without an index buffer. */
  draw(
    vertexCount: number,
    options: { instances?: number; first?: number; primitive?: keyof typeof MTL.PrimitiveType } = {},
  ): this {
    const type = MTL.PrimitiveType[options.primitive ?? "triangle"];
    const instances = options.instances ?? 1;
    if (instances === 1) {
      this.native.drawPrimitives_vertexStart_vertexCount_(type, options.first ?? 0, vertexCount);
    } else {
      this.native.drawPrimitives_vertexStart_vertexCount_instanceCount_(
        type, options.first ?? 0, vertexCount, instances,
      );
    }
    this.#draws++;
    return this;
  }

  /**
   * Draw indexed geometry, optionally instanced.
   *
   * `instances` is the lever that matters: one call here drawing 5,000
   * instances costs the same 1.2 microseconds as one drawing a single triangle.
   * What the instances cost is filling their buffer, which is per-object work
   * an order of magnitude cheaper than per-object encoding.
   */
  drawIndexed(
    indexBuffer: Bindable,
    indexCount: number,
    options: {
      instances?: number;
      indexType?: "uint16" | "uint32";
      offset?: number;
      primitive?: keyof typeof MTL.PrimitiveType;
    } = {},
  ): this {
    const type = MTL.PrimitiveType[options.primitive ?? "triangle"];
    const indexType = MTL.IndexType[options.indexType ?? "uint32"];
    const instances = options.instances ?? 1;
    if (instances === 1) {
      this.native.drawIndexedPrimitives_indexCount_indexType_indexBuffer_indexBufferOffset_(
        type, indexCount, indexType, nativeBuffer(indexBuffer), options.offset ?? 0,
      );
    } else {
      this.native.drawIndexedPrimitives_indexCount_indexType_indexBuffer_indexBufferOffset_instanceCount_(
        type, indexCount, indexType, nativeBuffer(indexBuffer), options.offset ?? 0, instances,
      );
    }
    this.#draws++;
    return this;
  }

  /** Draw calls recorded, for a frame-cost readout. */
  get drawCount(): number {
    return this.#draws;
  }

  end(): void {
    this.native.endEncoding();
  }
}

// ---------------------------------------------------------------------------
// Compute pass
// ---------------------------------------------------------------------------

export class ComputePass {
  readonly native: MTLObject;
  #pipeline: ComputePipeline | null = null;

  constructor(commands: MTLObject, label?: string) {
    this.native = commands.computeCommandEncoder();
    if (label) this.native.setLabel_(label);
  }

  pipeline(p: ComputePipeline): this {
    this.native.setComputePipelineState_(p.native);
    this.#pipeline = p;
    return this;
  }

  /** Bind by the names the kernel uses. See RenderPass.bind. */
  bind(values: Record<string, BindValue>): this {
    if (!this.#pipeline) throw new Error("bind() before pipeline(): the names come from the pipeline");
    const encoder = this.native;
    applyBindings(values, this.#pipeline.bindings, this.#pipeline.label, computeSetters(encoder));
    return this;
  }

  buffer(index: number, b: Bindable, offset = 0): this {
    this.native.setBuffer_offset_atIndex_(nativeBuffer(b), offset, index);
    return this;
  }

  bytes(index: number, data: ArrayBufferView): this {
    this.native.setBytes_length_atIndex_(ptr(data as never), data.byteLength, index);
    return this;
  }

  texture(index: number, t: Texture | MTLObject): this {
    this.native.setTexture_atIndex_(nativeOf(t), index);
    return this;
  }

  /**
   * Dispatch `items` threads, one per element.
   *
   * The threadgroup size defaults to the pipeline's own maximum, so the kernel
   * decides rather than the caller guessing. Kernels must bounds-check their
   * thread id, since the last group is usually partly out of range.
   */
  dispatch(items: number, options: { threadgroup?: number } = {}): this {
    if (!this.#pipeline) throw new Error("dispatch() before pipeline()");
    const width = Math.min(
      options.threadgroup ?? this.#pipeline.maxThreads,
      this.#pipeline.maxThreads,
    );
    const groups = Math.max(1, Math.ceil(items / width));
    this.native.dispatchThreadgroups_threadsPerThreadgroup_(size3(groups), size3(width));
    return this;
  }

  /**
   * Dispatch exactly `width × height × depth` threads — one per pixel of an image, or per cell
   * of a volume — in threadgroups of `threadgroup` (default 8×8×1, or 4×4×4 for a 3D grid).
   *
   * Uses Metal's non-uniform dispatch, so the edge groups are trimmed rather than run past the
   * edge: a kernel needs no bounds check on its `thread_position_in_grid`. Every Apple-silicon
   * GPU supports it.
   */
  dispatchThreads(
    width: number, height = 1, depth = 1,
    threadgroup: [number, number, number] = depth > 1 ? [4, 4, 4] : height > 1 ? [8, 8, 1] : [64, 1, 1],
  ): this {
    this.native.dispatchThreads_threadsPerThreadgroup_(
      size3(width, height, depth), size3(threadgroup[0], threadgroup[1], threadgroup[2]),
    );
    return this;
  }

  /** Dispatch an explicit 3D grid of threadgroups. */
  dispatchGroups(x: number, y = 1, z = 1, threadgroup: [number, number, number] = [8, 8, 1]): this {
    this.native.dispatchThreadgroups_threadsPerThreadgroup_(
      size3(x, y, z), size3(threadgroup[0], threadgroup[1], threadgroup[2]),
    );
    return this;
  }

  end(): void {
    this.native.endEncoding();
  }
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/**
 * One command buffer's worth of work.
 *
 * A frame is created for you by the view's onFrame callback, or by
 * `gpu.submit()` for work with no view attached.
 */
export class Frame {
  readonly commands: MTLObject;
  /** Seconds since the view started. */
  readonly time: number;
  /** Seconds since the previous frame. */
  readonly dt: number;
  readonly index: number;
  /** Drawable size in pixels. */
  readonly width: number;
  readonly height: number;

  // The attachments a view prepared, when the frame came from one. They are
  // exposed rather than hidden because a post-processing chain has to render
  // somewhere else first and only resolve to the drawable at the end.

  /** Where to render: the multisample texture, or the drawable's own. */
  colorTexture?: MTLObject;
  /** Where a multisampled pass resolves to. Undefined when sampleCount is 1. */
  resolveTexture?: MTLObject;
  depthTexture?: MTLObject;
  /** The CAMetalDrawable being presented, for the rare case that needs it. */
  drawable?: MTLObject;

  #passes = 0;

  constructor(
    commands: MTLObject,
    info: { time: number; dt: number; index: number; width: number; height: number },
  ) {
    this.commands = commands;
    this.time = info.time;
    this.dt = info.dt;
    this.index = info.index;
    this.width = info.width;
    this.height = info.height;
  }

  /** Open a render pass. Ends automatically if you pass a body. */
  render(o: RenderPassOptions): RenderPass;
  render(o: RenderPassOptions, body: (pass: RenderPass) => void): void;
  render(o: RenderPassOptions, body?: (pass: RenderPass) => void): RenderPass | void {
    this.#passes++;
    const pass = new RenderPass(this.commands, o);
    if (!body) return pass;
    try {
      body(pass);
    } finally {
      pass.end();
    }
  }

  /**
   * Run one kernel over `items` threads, as part of this frame.
   *
   *   frame.dispatch(simulate, particles.count, { particles, dt: frame.dt });
   *
   * Shares the frame's command buffer, so the simulation and the draw that
   * reads its output are ordered by the GPU rather than by a CPU wait.
   */
  dispatch(
    kernel: ComputePipeline,
    items: number,
    bind: Record<string, BindValue> = {},
    options: { threadgroup?: number } = {},
  ): this {
    this.compute((pass) => {
      pass.pipeline(kernel).bind(bind).dispatch(items, options);
    }, kernel.label);
    return this;
  }

  /** Open a compute pass. Ends automatically if you pass a body. */
  compute(body: (pass: ComputePass) => void, label?: string): void;
  compute(): ComputePass;
  compute(body?: (pass: ComputePass) => void, label?: string): ComputePass | void {
    this.#passes++;
    const pass = new ComputePass(this.commands, label);
    if (!body) return pass;
    try {
      body(pass);
    } finally {
      pass.end();
    }
  }

  /**
   * Run a full-screen effect into `to`.
   *
   * One line for what is otherwise a pass, a pipeline, a set of bindings and a
   * draw. Sampler bindings the effect declares but the caller did not supply
   * get a linear clamped sampler, which is what a post-process wants.
   */
  effect(effect: Effect, o: EffectPassOptions = {}): void {
    const to = o.to ?? this.resolveTexture ?? this.colorTexture;
    if (!to) throw new Error("effect() needs somewhere to render: pass { to }");

    const bind: Record<string, BindValue> = { ...o.bind };
    for (const binding of effect.bindings.all) {
      if (binding.kind === "sampler" && bind[binding.name] === undefined) {
        bind[binding.name] = gpu().linearSampler;
      }
    }

    this.render(
      {
        color: { texture: to, clear: o.clear ?? [0, 0, 0, 1] },
        label: o.label ?? effect.label,
      },
      (pass) => {
        pass.pipeline(effect.pipeline).bind(bind).draw(3);
      },
    );
  }

  /** Copy one texture into another, for post-processing chains. */
  blit(body: (encoder: MTLObject) => void): void {
    const encoder = this.commands.blitCommandEncoder();
    try {
      body(encoder);
    } finally {
      encoder.endEncoding();
    }
  }

  /**
   * Fill every mip level of `texture` below the first from the one above it, on the GPU — a
   * bloom or exposure chain's levels, or a volume's. The texture needs more than one level.
   */
  mipmaps(texture: Texture | MTLObject): void {
    this.blit((encoder) => encoder.generateMipmapsForTexture_(nativeOf(texture)));
  }

  get passCount(): number {
    return this.#passes;
  }
}
