// Scene3D: nodes, a camera and a light, drawn with one instanced call per mesh.
//
// This is the easy layer, and it sits on top of GPUView and the typed buffers
// rather than beside them, so the performance work is not something you opt
// into. Nodes sharing a geometry and a material are batched into a single
// instanced draw and their transforms are written straight into shared memory.
// Measured on an M2 Pro: a node costs about 0.12us per frame to transform and
// write, so twenty thousand animated nodes come to 2.3ms of JavaScript in one
// draw call. Drawing them one at a time would be 25ms of encoding alone.
//
// The way out is graded rather than a cliff. Give a node a Material and you are
// writing MSL against the same instanced pipeline. Turn on `bloom` and the
// scene renders to a 16-bit float buffer with a tone mapper on the end. Past
// that, drop to GPUView and write the passes yourself — Scene3D is a few
// hundred lines on top of the same public API, so nothing is lost by leaving.

import { objc } from "../objc.ts";
import { NIL, ptr } from "../bridge.ts";
import { BitmapImageFileType } from "../ui/appkit.ts";
import type { View } from "../ui/view.ts";
import {
  gpu, msl,
  type BlendMode, type GPU, type GPUArrayBuffer, type GPUBuffer,
  type MTLObject, type PixelFormatName, type RenderPipeline, type Snippet,
} from "./gpu.ts";
import { GPUView, type GPUViewOptions } from "./view.ts";
import { declarationsOf } from "./effects.ts";
import type { Frame, RenderPass } from "./frame.ts";
import type { Bloom, BloomOptions } from "./post.ts";
import { mat4x4f, strideOf, struct, vec4f } from "./types.ts";
import {
  boxGeometry, coneGeometry, cylinderGeometry, planeGeometry, sphereGeometry,
  Vertex, type Geometry,
} from "./geometry.ts";
import {
  compose, insetPerspective, lookAt, multiply, normalMatrix, perspective, radians, toVec3, v3normalize,
  type Insets4, type Mat4, type Vec3,
} from "./math.ts";

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export type Color = string | { r: number; g: number; b: number; a?: number } | readonly number[];

/** "#rgb", "#rrggbb", "#rrggbbaa", {r,g,b,a} or [r,g,b,a] in 0..1. */
export function parseColor(c: Color): [number, number, number, number] {
  if (Array.isArray(c)) return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1];
  if (typeof c !== "string") {
    const o = c as { r: number; g: number; b: number; a?: number };
    return [o.r, o.g, o.b, o.a ?? 1];
  }
  const hex = c.replace(/^#/, "");
  const n = (i: number, len: number) =>
    parseInt(len === 1 ? hex[i]! + hex[i]! : hex.substr(i, 2), 16) / 255;
  if (hex.length === 3) return [n(0, 1), n(1, 1), n(2, 1), 1];
  if (hex.length === 6) return [n(0, 2), n(2, 2), n(4, 2), 1];
  if (hex.length === 8) return [n(0, 2), n(2, 2), n(4, 2), n(6, 2)];
  return [1, 1, 1, 1];
}

// ---------------------------------------------------------------------------
// Schemas, shared by the CPU writer and the shader below
// ---------------------------------------------------------------------------

export const SceneUniforms = struct("SceneUniforms", {
  viewProjection: mat4x4f,
  lightDirection: vec4f,
  lightColor: vec4f,
  ambient: vec4f,
  eye: vec4f,
  /** x is seconds since the view started; the rest are yours. */
  time: vec4f,
});

export const InstanceData = struct("InstanceData", {
  model: mat4x4f,
  normalMatrix: mat4x4f,
  color: vec4f,
  /** Free per-node values a material can read. See Node.params. */
  params: vec4f,
});

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface MaterialOptions {
  /**
   * How to shade a fragment.
   *
   * Either the body of a fragment function — with `in` (the varyings), `u`
   * (SceneUniforms) and `params` (the node's four free floats) in scope,
   * returning a float4 — or a whole `fragment` function if you would rather
   * declare your own bindings.
   */
  fragment?: string;
  /**
   * Snippets the body calls. Emitted above the function, deduplicated.
   *
   * They go here rather than into the body, because a bare body is wrapped in
   * a function and MSL has no nested function definitions.
   */
  use?: readonly Snippet[];
  /** Declarations above the fragment function: helpers, constants, structs. */
  header?: string;
  blend?: BlendMode;
  /** Off for anything additive, or it punches a hole in what is behind it. */
  depthWrite?: boolean;
  cull?: "back" | "front" | "none";
  label?: string;
  /**
   * Whether the fragment reads the world-space normal. Default true — the
   * default fragment lights with it.
   *
   * False for anything flat or unlit, and it is worth saying: a node with a
   * non-uniform scale — every quad in a 2D diagram — otherwise costs an
   * inverse-transpose per frame for a normal nothing reads. Measured on a
   * timeline of a few thousand quads, that was 40% of each frame's encoding.
   */
  normals?: boolean;
}

/**
 * A shading program a node can be drawn with.
 *
 * Materials batch: two nodes sharing a material and a geometry are one
 * instanced draw, so a hundred identical beams cost the same as one.
 */
export class Material {
  readonly options: MaterialOptions;
  readonly label: string;
  /**
   * Whether this material blends with what is already there.
   *
   * Decides draw order, and that is not cosmetic: a blended surface writes no
   * depth, so anything opaque drawn after it overwrites it completely.
   */
  readonly transparent: boolean;
  /** Whether nodes drawn with it need a normal matrix. See `MaterialOptions.normals`. */
  readonly normals: boolean;
  #pipelines = new Map<string, RenderPipeline>();

  constructor(options: MaterialOptions = {}) {
    this.options = options;
    this.label = options.label ?? "material";
    this.transparent = !!options.blend && options.blend !== "none";
    this.normals = options.normals ?? true;
  }

  /** The pipeline for one set of attachment formats, compiled once. */
  pipeline(g: GPU, format: PixelFormatName, sampleCount: number, depthFormat: PixelFormatName): RenderPipeline {
    const key = `${format}|${sampleCount}|${depthFormat}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = g.renderPipeline({
        shader: sceneShader(this.options),
        vertex: "scene_vertex",
        fragment: "scene_fragment",
        format,
        depthFormat,
        sampleCount,
        blend: this.options.blend,
        cull: this.options.cull ?? "back",
        depth: { write: this.options.depthWrite ?? true },
        label: this.label,
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}

export const material = (o: MaterialOptions = {}) => new Material(o);

/**
 * Additive, depth-read-only, and multiplied up past 1.0 so bloom sees it.
 *
 * This is what makes something read as emitting rather than as being a bright
 * shape: additive so overlapping beams accumulate, no depth write so they do
 * not occlude each other, and a colour above 1.0 so the HDR buffer has
 * something for the bright pass to find.
 */
export function emissive(options: { intensity?: number } = {}): Material {
  const intensity = options.intensity ?? 3;
  return new Material({
    blend: "additive",
    depthWrite: false,
    cull: "none",
    label: "emissive",
    normals: false,
    fragment: `
      // params.x scales per node, so one material serves a whole rig.
      float strength = ${intensity.toFixed(3)} * (params.x > 0.0 ? params.x : 1.0);
      return float4(in.color.rgb * strength, in.color.a);
    `,
  });
}

/** The default: Lambert diffuse, hemisphere ambient, a narrow specular. */
export const DEFAULT_FRAGMENT = `
  float3 n = normalize(in.worldNormal);
  float3 l = normalize(u.lightDirection.xyz);
  float diffuse = max(dot(n, l), 0.0);

  // Hemisphere ambient: full strength facing the sky, half facing the ground.
  // Flat ambient makes everything read as a silhouette.
  float sky = n.y * 0.5 + 0.5;
  float3 ambient = u.ambient.rgb * u.ambient.w * mix(0.5, 1.0, sky);

  float3 viewDir = normalize(u.eye.xyz - in.worldPosition);
  // Not "half": that is MSL's 16-bit float type, and shadowing it is an error.
  float3 halfway = normalize(l + viewDir);
  float specular = pow(max(dot(n, halfway), 0.0), 48.0) * step(0.001, diffuse) * 0.25;

  float3 lit = in.color.rgb * (ambient + u.lightColor.rgb * u.lightColor.w * diffuse);
  return float4(lit + specular, in.color.a);
`;

/**
 * The vertex half every material shares, plus whichever fragment it brought.
 *
 * `packed_float3` for the vertex data is load-bearing: a plain float3 is
 * 16-byte aligned, which would make the stride 40 rather than the 32 the buffer
 * is packed with, and every vertex after the first would be read wrong. The
 * Vertex schema emits the packed spelling, so this cannot drift.
 */
export function sceneShader(o: MaterialOptions = {}): string {
  const fragment = o.fragment ?? DEFAULT_FRAGMENT;
  const body = /\bfragment\b/.test(fragment)
    ? fragment
    : `fragment float4 scene_fragment(
  Fragment in [[stage_in]],
  constant SceneUniforms &u [[buffer(1)]]
) {
  float4 params = in.params;
${fragment}
}`;

  return msl`
#include <metal_stdlib>
using namespace metal;

${SceneUniforms}

${InstanceData}

${Vertex}

struct Fragment {
  float4 position [[position]];
  float3 worldNormal;
  float3 worldPosition;
  float2 uv;
  float4 color;
  float4 params;
};

vertex Fragment scene_vertex(
  uint vid [[vertex_id]],
  uint iid [[instance_id]],
  device const Vertex *vertices [[buffer(0)]],
  constant SceneUniforms &u [[buffer(1)]],
  device const InstanceData *instances [[buffer(2)]]
) {
  Vertex v = vertices[vid];
  InstanceData inst = instances[iid];
  float4 world = inst.model * float4(v.position, 1.0);

  Fragment out;
  out.position = u.viewProjection * world;
  out.worldNormal = normalize((inst.normalMatrix * float4(v.normal, 0.0)).xyz);
  out.worldPosition = world.xyz;
  out.uv = v.uv;
  out.color = inst.color;
  out.params = inst.params;
  return out;
}

${declarationsOf(o.use)}
${o.header ?? ""}

${body}
`;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface NodeOptions {
  position?: Vec3 | readonly [number, number, number];
  rotation?: Vec3 | readonly [number, number, number];
  scale?: Vec3 | readonly [number, number, number] | number;
  color?: Color;
  visible?: boolean;
  material?: Material;
  /** Four free floats the material can read as `params`. */
  params?: readonly [number, number, number, number];
}

export class Node {
  readonly geometry: Geometry;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  color: [number, number, number, number];
  visible: boolean;
  material: Material | null;
  params: [number, number, number, number];

  /** @internal Reused every frame, so animating allocates nothing. */
  readonly _model: Mat4 = new Float32Array(16);
  /** @internal */
  readonly _normal: Mat4 = new Float32Array(16);

  constructor(geometry: Geometry, options: NodeOptions = {}) {
    this.geometry = geometry;
    this.position = toVec3(options.position ?? [0, 0, 0]);
    this.rotation = toVec3(options.rotation ?? [0, 0, 0]);
    this.scale = toVec3(options.scale ?? 1);
    this.color = parseColor(options.color ?? "#cccccc");
    this.visible = options.visible ?? true;
    this.material = options.material ?? null;
    this.params = [...(options.params ?? [1, 0, 0, 0])] as [number, number, number, number];
  }

  setColor(c: Color): this {
    this.color = parseColor(c);
    return this;
  }

  /**
   * Point the node's -Y axis at a target, which is how a beam is aimed.
   *
   * The Euler angles are derived for compose()'s Ry·Rx·Rz order specifically:
   * pitch away from straight down, then yaw. The negated arguments to atan2 are
   * not a sign slip — rotating (0,-1,0) by Rx leaves it in -z, so the yaw that
   * carries it to (dx, dz) is measured from -z, not +z.
   */
  aimAt(target: Vec3 | readonly [number, number, number]): this {
    const t = toVec3(target);
    const d = v3normalize({
      x: t.x - this.position.x, y: t.y - this.position.y, z: t.z - this.position.z,
    });
    this.rotation = {
      x: Math.acos(Math.min(1, Math.max(-1, -d.y))),
      y: Math.atan2(-d.x, -d.z),
      z: 0,
    };
    return this;
  }
}

type Sized<T> = NodeOptions & T;

/**
 * Only the shape keys reach the geometry builder.
 *
 * The builders memoise on their arguments so that identical shapes are the same
 * object and therefore one instanced draw. Handing them the node's position and
 * colour as well would make every key unique and quietly turn the whole scene
 * back into one draw call per node.
 */
function shapeOf<T extends object>(o: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export const box = (o: Sized<{ size?: number | readonly [number, number, number] }> = {}) =>
  new Node(boxGeometry(shapeOf(o, ["size"])), o);
export const sphere = (o: Sized<{ radius?: number; segments?: number; rings?: number }> = {}) =>
  new Node(sphereGeometry(shapeOf(o, ["radius", "segments", "rings"])), o);
export const plane = (o: Sized<{ size?: number | readonly [number, number]; segments?: number }> = {}) =>
  new Node(planeGeometry(shapeOf(o, ["size", "segments"])), o);
export const cylinder = (
  o: Sized<{ radius?: number; top?: number; height?: number; segments?: number; caps?: boolean }> = {},
) => new Node(cylinderGeometry(shapeOf(o, ["radius", "top", "height", "segments", "caps"])), o);
/** A cone with its apex at the node's position, opening downward along -Y. */
export const cone = (o: Sized<{ radius?: number; height?: number; segments?: number; caps?: boolean }> = {}) =>
  new Node(coneGeometry(shapeOf(o, ["radius", "height", "segments", "caps"])), o);
export const mesh = (geometry: Geometry, o: NodeOptions = {}) => new Node(geometry, o);

// ---------------------------------------------------------------------------
// Camera and light
// ---------------------------------------------------------------------------

export interface CameraOptions {
  position?: Vec3 | readonly [number, number, number];
  target?: Vec3 | readonly [number, number, number];
  up?: Vec3 | readonly [number, number, number];
  fov?: number;
  near?: number;
  far?: number;
}

export class Camera {
  position: Vec3; target: Vec3; up: Vec3;
  fov: number; near: number; far: number;
  /**
   * How much of each edge of the view is covered, **in points** — a glass sidebar, toolbar
   * or inspector the scene runs under. The projection is fitted to what is left: `fov` spans
   * the visible height and the visible centre is where the camera looks
   * ({@link insetPerspective}). All zero, the default, is the whole view.
   */
  insets: Insets4 = { top: 0, left: 0, bottom: 0, right: 0 };

  constructor(o: CameraOptions = {}) {
    this.position = toVec3(o.position ?? [0, 2, 6]);
    this.target = toVec3(o.target ?? [0, 0, 0]);
    this.up = toVec3(o.up ?? [0, 1, 0]);
    this.fov = o.fov ?? 55;
    this.near = o.near ?? 0.1;
    this.far = o.far ?? 200;
  }

  orbit(angleRadians: number, radius: number, height = this.position.y): this {
    this.position = {
      x: this.target.x + Math.cos(angleRadians) * radius,
      y: height,
      z: this.target.z + Math.sin(angleRadians) * radius,
    };
    return this;
  }
}

export interface LightOptions {
  direction?: Vec3 | readonly [number, number, number];
  color?: Color;
  intensity?: number;
  ambient?: Color;
  ambientIntensity?: number;
}

export class Light {
  direction: Vec3;
  color: [number, number, number, number];
  intensity: number;
  ambient: [number, number, number, number];
  ambientIntensity: number;

  constructor(o: LightOptions = {}) {
    this.direction = v3normalize(toVec3(o.direction ?? [0.4, 0.9, 0.5]));
    this.color = parseColor(o.color ?? "#ffffff");
    this.intensity = o.intensity ?? 1;
    this.ambient = parseColor(o.ambient ?? "#5d6478");
    this.ambientIntensity = o.ambientIntensity ?? 0.35;
  }
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface Scene3DOptions extends Omit<GPUViewOptions, "onFrame"> {
  background?: Color;
  camera?: CameraOptions | Camera;
  light?: LightOptions | Light;
  /**
   * Ceiling on nodes per batch. Default 100,000.
   *
   * Instance buffers start small and double as they fill, so this is a
   * backstop against a runaway scene rather than a size to tune.
   */
  maxInstances?: number;
  /** Render in HDR with a bloom chain and a tone mapper. Emissive needs it. */
  bloom?: boolean | BloomOptions;
  onFrame?: SceneHandler;
}

/**
 * What a scene's {@link Scene3D.renderer} is handed: the camera's matrices for this frame, worked
 * out exactly as the built-in pass would have used them (insets and all).
 *
 * The arrays are the scene's own and are rewritten every frame — valid during the call only.
 */
export interface SceneRenderInfo {
  view: Mat4;
  projection: Mat4;
  viewProjection: Mat4;
}

/** A frame drawn some other way than the built-in pass. See {@link Scene3D.renderer}. */
export type SceneRenderer = (frame: SceneFrame, info: SceneRenderInfo) => void;

/** The frame a scene handler sees: an ordinary Frame, plus its scene. */
export interface SceneFrame extends Frame {
  readonly scene: Scene3D;
}

export type SceneHandler = (frame: SceneFrame, scene: Scene3D) => void;

/**
 * Where each instance field sits, in floats, taken from the schema once.
 *
 * The per-frame fill writes through a Float32Array rather than through
 * InstanceData.write(), because it is the hottest loop in the library:
 * measured, the schema path costs 0.12us per node against 0.03us for the
 * direct writes, and at ten thousand nodes that is the difference between
 * 1.2ms of a frame and 0.16ms. The offsets still come from the schema, so the
 * two cannot disagree about the layout.
 */
const SLOT = {
  stride: strideOf(InstanceData) / 4,
  model: InstanceData.offsetOf("model") / 4,
  normal: InstanceData.offsetOf("normalMatrix") / 4,
  color: InstanceData.offsetOf("color") / 4,
  params: InstanceData.offsetOf("params") / 4,
};

interface Batch {
  material: Material;
  vertices: MTLObject;
  indices: MTLObject;
  indexCount: number;
  instances: GPUArrayBuffer<any>;
  /** The instance buffer as floats, refreshed whenever the buffer is replaced. */
  floats: Float32Array;
  nodes: Node[];
  /** Mean distance from the camera, for ordering the transparent batches. */
  depth: number;
}

export class Scene3D extends GPUView {
  readonly camera: Camera;
  readonly light: Light;
  background: [number, number, number, number];
  /** The post chain, when `bloom` was asked for. Tune it live. */
  readonly post: Bloom | null;
  /**
   * Draw the frame yourself, with this scene's camera, frame loop and handlers.
   *
   * When set, every frame still runs the handlers and works out the camera's matrices, then
   * hands them to this function **instead of** encoding the built-in pass: the nodes are not
   * drawn (nor their instance buffers filled) and the bloom chain does not run. The renderer
   * writes the finished picture to `frame.resolveTexture ?? frame.colorTexture` — single-sampled
   * when the view resolves, multisampled otherwise. `null` (the default) draws the nodes.
   *
   * A host uses it for a second way of drawing the same world — a far heavier one, say — that
   * it can switch to and from without rebuilding the view.
   */
  renderer: SceneRenderer | null = null;

  #uniforms: GPUBuffer<any>;
  #defaultMaterial = new Material({ label: "lit" });
  #batches = new Map<string, Batch>();
  #nodes: Node[] = [];
  #handlers: SceneHandler[] = [];
  #maxInstances: number;
  #view: Mat4 = new Float32Array(16);
  #projection: Mat4 = new Float32Array(16);
  #viewProjection: Mat4 = new Float32Array(16);

  constructor(options: Scene3DOptions = {}) {
    super({ ...options, animate: false, onFrame: undefined });
    const g = gpu();

    this.camera = options.camera instanceof Camera ? options.camera : new Camera(options.camera);
    this.light = options.light instanceof Light ? options.light : new Light(options.light);
    this.background = parseColor(options.background ?? "#0b0b0f");
    this.#maxInstances = options.maxInstances ?? 100_000;
    this.#uniforms = g.buffer(SceneUniforms, { label: "scene uniforms" });

    this.post = options.bloom
      ? g.bloom({
          ...(typeof options.bloom === "object" ? options.bloom : {}),
          sampleCount: this.sampleCount,
        })
      : null;

    super.onFrame((frame) => this.#render(frame));
    if (options.onFrame) this.#handlers.push(options.onFrame);
    if (options.animate !== false) this.start();
  }

  // --- scene graph ---------------------------------------------------------

  add<T extends Node>(node: T): T;
  add(child: View): this;
  add(item: any): any {
    if (item instanceof Node) {
      this.#nodes.push(item);
      this.#batchFor(item).nodes.push(item);
      return item;
    }
    return super.add(item);
  }

  remove(node: Node): this {
    const i = this.#nodes.indexOf(node);
    if (i >= 0) this.#nodes.splice(i, 1);
    for (const batch of this.#batches.values()) {
      const j = batch.nodes.indexOf(node);
      if (j >= 0) batch.nodes.splice(j, 1);
    }
    return this;
  }

  clear(): this {
    this.#nodes = [];
    for (const b of this.#batches.values()) b.nodes = [];
    return this;
  }

  get nodes(): readonly Node[] {
    return this.#nodes;
  }

  /** Draw calls the next frame will take: one per geometry-and-material pair. */
  get batchCount(): number {
    let n = 0;
    for (const b of this.#batches.values()) if (b.nodes.some((x) => x.visible)) n++;
    return n;
  }

  /** Run before each frame is encoded, so what it changes lands this frame. */
  onFrame(fn: SceneHandler): this {
    this.#handlers.push(fn);
    return this;
  }

  #keys = new WeakMap<object, number>();
  #nextKey = 0;

  /** Identity for a geometry or material, so a pair can key a Map. */
  #idOf(o: object): number {
    let id = this.#keys.get(o);
    if (id === undefined) {
      id = this.#nextKey++;
      this.#keys.set(o, id);
    }
    return id;
  }

  #warned = new Set<string>();

  /**
   * Grow a batch's instance buffer to hold `needed`, doubling as it goes.
   *
   * The old buffer is dropped rather than copied: every instance is rewritten
   * from the nodes on the very next line, so its contents are already stale.
   */
  #reserve(batch: Batch, needed: number): void {
    if (needed <= batch.instances.capacity) return;
    if (needed > this.#maxInstances) {
      if (!this.#warned.has(batch.material.label)) {
        this.#warned.add(batch.material.label);
        console.warn(
          `[Scene3D] ${needed} nodes in the "${batch.material.label}" batch exceeds ` +
            `maxInstances (${this.#maxInstances}); the rest will not be drawn.`,
        );
      }
      needed = this.#maxInstances;
      if (needed <= batch.instances.capacity) return;
    }
    let capacity = Math.max(16, batch.instances.capacity);
    while (capacity < needed) capacity *= 2;
    batch.instances = gpu().array(InstanceData, capacity, { label: "instances" });
    batch.floats = batch.instances.floats();
  }

  #batchFor(node: Node): Batch {
    const material = node.material ?? this.#defaultMaterial;
    const key = `${this.#idOf(node.geometry)}:${this.#idOf(material)}`;
    let batch = this.#batches.get(key);
    if (!batch) {
      const g = gpu();
      batch = {
        material,
        vertices: g.data(node.geometry.vertices, { label: "vertices" }),
        indices: g.data(node.geometry.indices, { label: "indices" }),
        indexCount: node.geometry.indices.length,
        // Sized to what is actually drawn, not to the ceiling: a scene with
        // fifty batches would otherwise reserve a megabyte each for buffers
        // holding a handful of instances.
        instances: g.array(InstanceData, 16, { label: "instances" }),
        floats: new Float32Array(0),
        nodes: [],
        depth: 0,
      };
      batch.floats = batch.instances.floats();
      this.#batches.set(key, batch);
    }
    return batch;
  }

  // --- rendering -----------------------------------------------------------

  #render(frame: Frame): void {
    const scene = frame as SceneFrame;
    (scene as { scene: Scene3D }).scene = this;
    for (const fn of this.#handlers) {
      try {
        fn(scene, this);
      } catch (e) {
        console.error("[Scene3D] frame handler failed:", e);
      }
    }

    lookAt(this.camera.position, this.camera.target, this.camera.up, this.#view);
    const insets = this.camera.insets;
    if (insets.top === 0 && insets.left === 0 && insets.bottom === 0 && insets.right === 0) {
      perspective(
        radians(this.camera.fov),
        frame.width / Math.max(1, frame.height),
        this.camera.near, this.camera.far, this.#projection,
      );
    } else {
      // Insets are points and the drawable is pixels; only the ratio matters, so measure the
      // view in points rather than converting every inset.
      const bounds = this.native.bounds();
      insetPerspective(
        radians(this.camera.fov),
        Number(bounds.width), Number(bounds.height), insets,
        this.camera.near, this.camera.far, this.#projection,
      );
    }
    multiply(this.#projection, this.#view, this.#viewProjection);

    if (this.renderer) {
      this.renderer(scene, {
        view: this.#view, projection: this.#projection, viewProjection: this.#viewProjection,
      });
      return;
    }

    this.#uniforms.write({
      viewProjection: this.#viewProjection,
      lightDirection: [this.light.direction.x, this.light.direction.y, this.light.direction.z, 0],
      lightColor: [this.light.color[0], this.light.color[1], this.light.color[2], this.light.intensity],
      ambient: [this.light.ambient[0], this.light.ambient[1], this.light.ambient[2], this.light.ambientIntensity],
      eye: [this.camera.position.x, this.camera.position.y, this.camera.position.z, 1],
      time: [frame.time, frame.dt, frame.index, 0],
    });

    // One instance-buffer fill and one draw per batch.
    const eye = this.camera.position;
    for (const batch of this.#batches.values()) {
      let visible = 0;
      for (const node of batch.nodes) if (node.visible) visible++;
      this.#reserve(batch, visible);

      const out = batch.floats;
      const normals = batch.material.normals;
      let n = 0;
      let depth = 0;
      for (const node of batch.nodes) {
        if (!node.visible || n >= batch.instances.capacity) continue;
        const model = compose(node.position, node.rotation, node.scale, node._model);
        const base = n++ * SLOT.stride;
        out.set(node._model, base + SLOT.model);
        // A material that never reads the normal gets whatever the slot held.
        if (normals) {
          // Under uniform scale the model matrix already carries normals in the
          // right direction — the shader normalises, so the scale factor cancels.
          // Only a non-uniform scale skews them, and only that needs the
          // inverse-transpose, which is about a third of the per-node cost.
          const { x: sx, y: sy, z: sz } = node.scale;
          if (sx === sy && sy === sz) {
            node._normal.set(model);
            node._normal[12] = 0;
            node._normal[13] = 0;
            node._normal[14] = 0;
          } else {
            normalMatrix(model, node._normal);
          }
          out.set(node._normal, base + SLOT.normal);
        }
        const c = base + SLOT.color;
        out[c] = node.color[0]; out[c + 1] = node.color[1];
        out[c + 2] = node.color[2]; out[c + 3] = node.color[3];
        const p = base + SLOT.params;
        out[p] = node.params[0]; out[p + 1] = node.params[1];
        out[p + 2] = node.params[2]; out[p + 3] = node.params[3];

        const dx = node.position.x - eye.x;
        const dy = node.position.y - eye.y;
        const dz = node.position.z - eye.z;
        depth += dx * dx + dy * dy + dz * dz;
      }
      batch.instances.count = n;
      batch.depth = n > 0 ? depth / n : 0;
    }

    // Opaque first, then blended back to front. Ordering is per batch, not per
    // object — sorting individual nodes would mean one draw call each, which
    // costs more than it buys. Additive blending does not care about order at
    // all, and that is what most of this is.
    const order = [...this.#batches.values()]
      .filter((b) => b.instances.count > 0)
      .sort((a, b) =>
        a.material.transparent === b.material.transparent
          ? b.depth - a.depth
          : (a.material.transparent ? 1 : 0) - (b.material.transparent ? 1 : 0));

    const g = gpu();
    const post = this.post;
    if (post) post.resize(frame.width, frame.height);

    const format: PixelFormatName = post ? "rgba16float" : this.formatName;
    const depthFormat: PixelFormatName = "depth32float";

    frame.render(
      post
        ? { target: post.scene, clear: this.background, label: "scene" }
        : {
            color: {
              texture: frame.colorTexture!, clear: this.background, resolve: frame.resolveTexture,
            },
            depth: frame.depthTexture,
            label: "scene",
          },
      (pass: RenderPass) => {
        for (const batch of order) {
          pass.pipeline(batch.material.pipeline(g, format, this.sampleCount, depthFormat));
          pass.bind({
            vertices: batch.vertices,
            u: this.#uniforms,
            instances: batch.instances,
          });
          pass.drawIndexed(batch.indices, batch.indexCount, { instances: batch.instances.count });
        }
      },
    );

    if (post) post.apply(frame, frame.resolveTexture ?? frame.colorTexture);
  }

  /** Render off-screen and write a PNG. Returns the file size in bytes. */
  snapshot(path: string, width = 640, height = 480): number {
    const { pixels } = this.capture(width, height);
    // The rep references our buffer: created with NULL planes it does not
    // allocate until drawn into, so bitmapData would come back nil.
    const planes = new BigUint64Array([BigInt(ptr(pixels))]);
    const rep = objc.NSBitmapImageRep.alloc()
      .initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
        ptr(planes), width, height, 8, 4, true, false, "NSDeviceRGBColorSpace", width * 4, 32,
      );
    if (!rep || rep.ptr === NIL) throw new Error("could not wrap the capture");
    const data = rep.representationUsingType_properties_(
      BitmapImageFileType.PNG, objc.NSDictionary.dictionary(),
    );
    if (!data || data.ptr === NIL) throw new Error("could not encode PNG");
    if (!data.writeToFile_atomically_(path, true)) throw new Error(`could not write ${path}`);
    return Number(data.length());
  }
}
