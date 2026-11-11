// Metal: typed GPU programming, and a 3D scene built on it.
//
//   import { gpu, struct, vec4f, mat4x4f, msl, GPUView } from "bunkit/metal";
//
// Three layers, same as the rest of BunKit. `Scene3D` is the easy one: nodes,
// a camera, a light. `GPUView` is the surface plus a frame loop, and you write
// the passes. `gpu()` is the device, and everything it hands out — buffers,
// shaders, pipelines, textures — carries `.native` for raw Objective-C.

export * from "./types.ts";
export * from "./reflect.ts";
export * from "./gpu.ts";
export * from "./effects.ts";
export * from "./shaders.ts";
export * from "./post.ts";
export * from "./frame.ts";
export * from "./view.ts";
export * from "./present.ts";
export * from "./math.ts";
export * from "./geometry.ts";
export * from "./scene.ts";
export * from "./metalfx.ts";
export * from "./timer.ts";
