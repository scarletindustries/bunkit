// The typed GPU stack: layouts, reflection, binding, compute, and effects.
//
// The first section is the one that matters most. It declares a struct with
// every awkward type in it, hands the generated MSL to the Metal compiler, and
// compares the compiler's reported offsets against the ones types.ts computed.
// If Apple ever changes a padding rule, this fails on the next SDK rather than
// three months later as a scene that renders wrong on someone else's machine.

import {
  arrayOf, boolean32, describeLayout, f32, i32, mat3x3f, mat4x4f, packed2f, packed3f,
  struct, strideOf, u32, vec2f, vec3f, vec4f,
  Frame, gpu, gpuAvailable, msl, snippet,
  Material, Scene3D, box, emissive, sphere,
  aces, fbm3, kelvin,
} from "../src/metal/index.ts";
import { initApp, pumpOnce } from "../src/runtime.ts";
import { Label, VStack, Window, snapshotWindow } from "../src/ui/index.ts";
import { objc } from "../src/objc.ts";
import { ptr } from "../src/bridge.ts";
import { BitmapImageFileType } from "../src/ui/appkit.ts";

let failures = 0;
function check(name: string, cond: any, extra?: any) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}
const close = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

initApp();

if (!gpuAvailable()) {
  console.log("  (no Metal device here — skipping every GPU check)");
  console.log("\nGPU TESTS SKIPPED");
  process.exit(0);
}

const g = gpu();

/** Write RGBA8 pixels to a PNG, so the loader has something real to read. */
function writePNG(path: string, pixels: Uint8Array, width: number, height: number): void {
  const planes = new BigUint64Array([BigInt(ptr(pixels))]);
  const rep = objc.NSBitmapImageRep.alloc()
    .initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
      ptr(planes), width, height, 8, 4, true, false, "NSDeviceRGBColorSpace", width * 4, 32,
    );
  rep.representationUsingType_properties_(BitmapImageFileType.PNG, objc.NSDictionary.dictionary())
    .writeToFile_atomically_(path, true);
}

// ---------------------------------------------------------------------------
// Schema layouts, checked against the Metal compiler itself
// ---------------------------------------------------------------------------

{
  // Every rule worth getting wrong: a float3 padded to 16, a float3x3 whose
  // columns are padded, a packed_float3 that is not, and scalars that have to
  // land in the gaps.
  const Awkward = struct("Awkward", {
    a: f32,
    b: vec3f,
    c: f32,
    d: mat3x3f,
    e: packed3f,
    f: f32,
    g: vec2f,
    h: mat4x4f,
    i: u32,
    j: vec4f,
    k: packed2f,
    l: i32,
  });

  const probe = g.renderPipeline({
    shader: msl`
#include <metal_stdlib>
using namespace metal;

${Awkward}

vertex float4 vs(constant Awkward &probe [[buffer(0)]]) {
  // Touch every member, or the optimiser drops them from the reflection.
  return float4(probe.a + probe.c + probe.f + probe.i + probe.l, probe.b.x + probe.e.y,
                probe.d[0].x + probe.h[3].w, probe.g.x + probe.j.z + probe.k.y);
}
fragment float4 fs() { return 1; }`,
    depthFormat: null,
    label: "layout probe",
  });

  const reflected = probe.bindings.get("probe")?.struct;
  check("the compiler reports the probe struct", !!reflected);

  if (reflected) {
    let mismatches: string[] = [];
    for (const field of Awkward.fields) {
      const theirs = reflected.fields.find((f) => f.name === field.name);
      if (!theirs) {
        mismatches.push(`${field.name}: missing`);
      } else if (theirs.offset !== field.offset) {
        mismatches.push(`${field.name}: ours ${field.offset}, Metal ${theirs.offset}`);
      }
    }
    check("every field offset matches the Metal compiler", mismatches.length === 0, mismatches);
    check("the struct size matches the compiler",
      Awkward.size === probe.bindings.get("probe")!.size,
      `${Awkward.size} vs ${probe.bindings.get("probe")!.size}`);
  }

  // The documented rules, stated as assertions so a regression says which one.
  check("float3 is 16 bytes, 16-aligned", vec3f.size === 16 && vec3f.alignment === 16);
  check("packed_float3 is 12 bytes, 4-aligned", packed3f.size === 12 && packed3f.alignment === 4);
  check("float3x3 is 48 bytes", mat3x3f.size === 48);
  check("float4x4 is 64 bytes", mat4x4f.size === 64);
  check("an array strides by the rounded-up element size",
    strideOf(arrayOf(vec3f, 4).element) === 16 && arrayOf(f32, 4).size === 16);
  check("describeLayout names the fields", describeLayout(Awkward).includes("d "));
}

// ---------------------------------------------------------------------------
// Typed buffers
// ---------------------------------------------------------------------------

{
  const Uniform = struct("Uniform", { tint: vec4f, count: u32, enabled: boolean32 });
  const buffer = g.buffer(Uniform, { label: "uniform" });
  buffer.write({ tint: [0.25, 0.5, 0.75, 1], count: 7, enabled: true });
  const read = buffer.read();
  check("a struct round-trips through a buffer",
    close((read.tint as number[])[1]!, 0.5) && read.count === 7 && read.enabled === true, read);

  buffer.writeField("count", 9);
  check("writeField leaves the other fields alone",
    buffer.read().count === 9 && close((buffer.read().tint as number[])[2]!, 0.75));

  const Particle = struct("Particle", { position: vec3f, life: f32 });
  const array = g.array(Particle, 128, { label: "particles" });
  array.fill([{ position: [1, 2, 3], life: 0.5 }, { position: [4, 5, 6], life: 0.25 }]);
  check("an array buffer sets count from fill()", array.count === 2);
  check("elements land at their stride",
    close((array.get(1).position as number[])[0]!, 4) && close(array.get(1).life as number, 0.25),
    array.get(1));

  let threw = false;
  try { array.set(999, { position: [0, 0, 0], life: 0 }); } catch { threw = true; }
  check("writing past the capacity throws rather than corrupting", threw);

  // Shared storage: the CPU and GPU address the same memory, so a write is
  // visible without an upload step. That is the whole reason instancing is cheap.
  check("the buffer is mapped, not copied", array.bytes.byteLength >= 128 * strideOf(Particle));
}

// ---------------------------------------------------------------------------
// Reflection and binding by name
// ---------------------------------------------------------------------------

const SHADER = msl`
#include <metal_stdlib>
using namespace metal;

struct Style { float4 tint; float2 centre; float radius; };
struct V { float4 position [[position]]; float2 uv; };

vertex V vs(uint vid [[vertex_id]], constant Style &style [[buffer(3)]]) {
  float2 p = float2((vid << 1) & 2, vid & 2);
  V o;
  o.position = float4(p * 2.0 - 1.0, 0, 1) * (style.radius > -1.0 ? 1.0 : 0.0);
  o.uv = p;
  return o;
}

fragment float4 fs(V in [[stage_in]], constant Style &style [[buffer(1)]],
                   texture2d<float> tex [[texture(2)]], sampler smp [[sampler(0)]]) {
  float d = distance(in.uv, style.centre);
  return d < style.radius ? style.tint * tex.sample(smp, in.uv) : float4(0, 0, 0, 1);
}`;

const pipeline = g.renderPipeline({ shader: SHADER, format: "rgba8unorm", depthFormat: null, label: "circle" });

{
  const style = pipeline.bindings.get("style");
  check("a binding is found by name", !!style);
  check("the same name on both stages keeps both indices",
    style?.slots.vertex === 3 && style?.slots.fragment === 1, style?.slots);
  check("its struct layout comes back from the compiler",
    style?.struct?.fields.map((f) => f.name).join(",") === "tint,centre,radius",
    style?.struct?.fields.map((f) => f.name));
  check("textures and samplers are classified",
    pipeline.bindings.get("tex")?.kind === "texture" &&
    pipeline.bindings.get("smp")?.kind === "sampler");
  check("entry points are found without being named",
    pipeline.shader.entries.vertex.join() === "vs" && pipeline.shader.entries.fragment.join() === "fs");
  check("describe() lists what is bindable", pipeline.bindings.describe().includes("tint"));
}

const white = g.texture({ width: 2, height: 2, format: "rgba8unorm", usage: ["shaderRead"], storage: "shared" });
white.write(new Uint8Array(2 * 2 * 4).fill(255));

function renderCircle(bind: Record<string, any>, size = 32) {
  const target = g.texture({
    width: size, height: size, format: "rgba8unorm",
    usage: ["renderTarget", "shaderRead"], storage: "shared", label: "circle target",
  });
  g.submit((commands) => {
    const frame = new Frame(commands, { time: 0, dt: 0, index: 0, width: size, height: size });
    frame.render({ color: { texture: target, clear: [0, 0, 0, 1] } }, (pass) => {
      pass.pipeline(pipeline).bind(bind).draw(3);
    });
  });
  const pixels = target.read();
  return (x: number, y: number) => [...pixels.slice((y * size + x) * 4, (y * size + x) * 4 + 3)];
}

{
  // The headline: nothing about this struct is declared in TypeScript. The
  // layout came from the compiler, and the plain object is packed into it.
  const at = renderCircle({
    style: { tint: [0, 1, 0, 1], centre: [0.5, 0.5], radius: 0.3 },
    tex: white,
    smp: g.linearSampler,
  });
  check("a plain object packs into the shader's struct", at(16, 16).join() === "0,255,0", at(16, 16));
  check("and the parts outside it are untouched", at(1, 1).join() === "0,0,0", at(1, 1));

  const small = renderCircle({
    style: { tint: [1, 0, 0, 1], centre: [0.5, 0.5], radius: 0.05 },
    tex: white, smp: g.linearSampler,
  });
  check("changing one field changes the frame", small(16, 8).join() === "0,0,0", small(16, 8));

  let message = "";
  try {
    renderCircle({ styel: { tint: [1, 1, 1, 1] }, tex: white, smp: g.linearSampler });
  } catch (e) {
    message = String(e);
  }
  check("a misspelled binding names the ones that exist",
    message.includes("styel") && message.includes("style"), message.slice(0, 120));
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

{
  const Body = struct("Body", { position: vec3f, velocity: vec3f });
  const bodies = g.array(Body, 2048, { label: "bodies" });
  for (let i = 0; i < 2048; i++) bodies.set(i, { position: [i, 0, 0], velocity: [1, 2, 3] });
  bodies.count = 2048;

  const step = g.kernel(msl`
#include <metal_stdlib>
using namespace metal;

${Body}

kernel void step(device Body *bodies [[buffer(0)]],
                 constant float &dt [[buffer(1)]],
                 constant uint &count [[buffer(2)]],
                 uint i [[thread_position_in_grid]]) {
  if (i >= count) return;
  bodies[i].position += bodies[i].velocity * dt;
}`);

  check("a kernel finds its own entry point", step.label === "step");
  check("it reports a threadgroup width", step.maxThreads >= 32 && step.threadExecutionWidth >= 8,
    `${step.maxThreads}/${step.threadExecutionWidth}`);

  step.run(2048, { bodies, dt: 0.5, count: 2048 });
  const one = bodies.get(7);
  check("the kernel wrote through shared memory",
    close((one.position as number[])[0]!, 7.5) && close((one.position as number[])[1]!, 1), one);

  // The last threadgroup runs past the end; the bounds check is what keeps it
  // from writing outside the buffer.
  const tail = bodies.get(2047);
  check("the last element was reached", close((tail.position as number[])[0]!, 2047.5), tail);

  const untouched = bodies.get(2047);
  step.run(2000, { bodies, dt: 1, count: 2000 });
  check("count bounds the work, not the dispatch size",
    close((bodies.get(2047).position as number[])[0]!, (untouched.position as number[])[0]!),
    bodies.get(2047));
}

// ---------------------------------------------------------------------------
// Compute feeding a draw, in one command buffer
// ---------------------------------------------------------------------------

{
  // The pattern a GPU particle system is: a kernel writes the buffer, and the
  // draw in the same command buffer reads it. Ordering is the GPU's job — if it
  // were not, this would render the buffer's previous contents.
  const P = struct("P", { position: vec4f, color: vec4f });
  const Sim = struct("Sim", { count: u32, spread: f32 });
  const N = 2048;
  const points = g.array(P, N, { label: "points" });
  for (let i = 0; i < N; i++) points.set(i, { position: [0, 0, 0, 1], color: [1, 0.6, 0.2, 1] });
  points.count = N;

  const place = g.kernel(msl`
#include <metal_stdlib>
using namespace metal;

${P}

${Sim}

kernel void place(device P *points [[buffer(0)]],
                  constant Sim &sim [[buffer(1)]],
                  uint i [[thread_position_in_grid]]) {
  if (i >= sim.count) return;
  float a = float(i) / float(sim.count) * 6.2831853;
  points[i].position = float4(cos(a) * sim.spread, sin(a) * sim.spread, 0.0, 1.0);
}`);

  const Style = struct("Style", { style: vec4f });
  const style = g.buffer(Style);
  style.write({ style: [10, 1, 0, 0] });

  const points3 = g.renderPipeline({
    shader: msl`
#include <metal_stdlib>
using namespace metal;

${P}

${Style}

struct F { float4 position [[position]]; float size [[point_size]]; float4 color; };

vertex F vs(uint vid [[vertex_id]], device const P *points [[buffer(0)]],
            constant Style &style [[buffer(1)]]) {
  F o;
  o.position = float4(points[vid].position.xy, 0.0, 1.0);
  o.size = style.style.x;
  o.color = points[vid].color;
  return o;
}

fragment float4 fs(F in [[stage_in]], float2 uv [[point_coord]]) {
  float falloff = pow(saturate(1.0 - length(uv - 0.5) * 2.0), 2.0);
  if (falloff <= 0.0) discard_fragment();
  return float4(in.color.rgb * falloff, 1.0);
}`,
    format: "rgba8unorm", depthFormat: null, blend: "additive", cull: "none", label: "points",
  });

  const size = 128;
  const out = g.texture({
    width: size, height: size, format: "rgba8unorm",
    usage: ["renderTarget", "shaderRead"], storage: "shared",
  });
  g.submit((commands) => {
    const frame = new Frame(commands, { time: 0, dt: 1 / 60, index: 0, width: size, height: size });
    frame.dispatch(place, N, { points, sim: { count: N, spread: 0.6 } });
    frame.render({ color: { texture: out, clear: [0, 0, 0, 1] } }, (pass) => {
      pass.pipeline(points3).bind({ points, style }).draw(N, { primitive: "point" });
    });
  });

  const pixels = out.read();
  const at = (x: number, y: number) => pixels[(y * size + x) * 4]!;
  check("point primitives rasterise with a size and a coord",
    at(size - 26, size / 2) > 100, at(size - 26, size / 2));
  check("the draw saw what the compute pass wrote", at(size / 2, size / 2) < 30, at(size / 2, size / 2));
  check("and the ring did not fill the whole target", at(2, 2) < 20, at(2, 2));
  check("shared storage shows the kernel's output on the cpu too",
    Math.abs((points.get(0).position as number[])[0]! - 0.6) < 1e-3, points.get(0).position);
}

// ---------------------------------------------------------------------------
// Effects and render targets
// ---------------------------------------------------------------------------

{
  const invert = g.effect(`return float4(1.0 - src.sample(smp, uv).rgb, 1.0);`);
  check("a one-line effect compiles", !!invert.pipeline);
  check("its sampler is discovered", invert.bindings.get("smp")?.kind === "sampler");

  const source = g.texture({
    width: 8, height: 8, format: "rgba8unorm", usage: ["shaderRead", "renderTarget"], storage: "shared",
  });
  source.write(new Uint8Array(8 * 8 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 200 : 0)));

  const out = g.target({ width: 8, height: 8, format: "rgba8unorm" });
  g.submit((commands) => {
    const frame = new Frame(commands, { time: 0, dt: 0, index: 0, width: 8, height: 8 });
    // No sampler passed: the effect binds the default linear one itself.
    frame.effect(invert, { to: out.color, bind: { src: source } });
  });
  const pixels = out.color.read();
  check("the effect ran and the sampler was supplied",
    pixels[0] === 55 && pixels[1] === 255, [...pixels.slice(0, 4)]);

  out.resize(16, 16);
  check("a target reallocates on resize", out.width === 16 && out.color.width === 16);
  const same = out.color;
  out.resize(16, 16);
  check("and does nothing when the size is unchanged", out.color === same);

  const msaa = g.target({ width: 8, height: 8, format: "rgba8unorm", sampleCount: 4 });
  check("a multisampled target carries a resolve texture",
    msaa.resolve !== null && msaa.readable === msaa.resolve);
  check("a single-sampled one reads from its colour", out.readable === out.color);

  const pair = g.pingPong({ width: 4, height: 4 });
  const front = pair.front;
  pair.swap();
  check("ping-pong swaps", pair.back === front && pair.front !== front);
}

// ---------------------------------------------------------------------------
// Loading an image
// ---------------------------------------------------------------------------

{
  // Written top-down, so a texture that loads upside down fails here rather
  // than as a scene where every texture is mirrored and nobody notices.
  const W = 16;
  const source = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const topLeft = x < W / 2 && y < W / 2;
      source[i] = topLeft ? 255 : 0;
      source[i + 2] = topLeft ? 0 : 255;
      source[i + 3] = 255;
    }
  }
  const path = `${process.env.TMPDIR ?? "/tmp"}/bunkit-texture-test.png`;
  writePNG(path, source, W, W);

  const texture = g.loadTexture(path);
  check("an image file loads at its own size", texture.width === W && texture.height === W);
  const back = texture.read();
  const at = (x: number, y: number) => [...back.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
  check("row 0 is the top, as Metal samples it", at(2, 2).join() === "255,0,0", at(2, 2));
  check("and the rest came through", at(13, 13).join() === "0,0,255", at(13, 13));

  let threw = false;
  try { g.loadTexture(`${path}.missing`); } catch { threw = true; }
  check("a missing file says so", threw);
}

// ---------------------------------------------------------------------------
// Reading depth in a later pass
// ---------------------------------------------------------------------------

{
  // Depth-aware fog, soft particles and depth of field all need the depth
  // buffer after the pass that wrote it. That takes two things: the texture
  // created with shaderRead, and the pass storing rather than discarding it.
  const W = 64;
  const target = g.target({ width: W, height: W, format: "rgba8unorm", depth: true });
  const out = g.texture({
    width: W, height: W, format: "rgba8unorm",
    usage: ["renderTarget", "shaderRead"], storage: "shared",
  });

  const quad = g.renderPipeline({
    shader: `#include <metal_stdlib>
using namespace metal;
struct V { float4 position [[position]]; };
vertex V vs(uint vid [[vertex_id]], constant float2 &shape [[buffer(0)]]) {
  float2 c[6] = { float2(-1,-1), float2(1,-1), float2(-1,1),
                  float2(1,-1), float2(1,1), float2(-1,1) };
  V o;
  o.position = float4(c[vid] * shape.x, shape.y, 1.0);
  return o;
}
fragment float4 fs() { return float4(0.2, 0.2, 0.2, 1.0); }`,
    format: "rgba8unorm", depthFormat: "depth32float", cull: "none", label: "depth quad",
  });

  const showDepth = g.effect({
    fragment: `
fragment float4 show(Varying vary [[stage_in]],
                     depth2d<float> sceneDepth [[texture(0)]],
                     sampler smp [[sampler(0)]]) {
  return float4(float3(sceneDepth.sample(smp, vary.uv)), 1.0);
}`,
    format: "rgba8unorm", label: "show depth",
  });
  check("a depth texture binds like any other", showDepth.bindings.get("sceneDepth")?.kind === "texture");

  const render = (storeDepth: boolean) => {
    g.submit((commands) => {
      const frame = new Frame(commands, { time: 0, dt: 0, index: 0, width: W, height: W });
      frame.render({ target, clear: [0, 0, 0, 1], storeDepth }, (pass) => {
        // Half-width quad at 0.25 through the depth range.
        pass.pipeline(quad).bind({ shape: [0.5, 0.25] }).draw(6);
      });
      frame.effect(showDepth, { to: out, bind: { sceneDepth: target.depth! } });
    });
    return out.read();
  };

  const stored = render(true);
  const at = (px: Uint8Array, x: number, y: number) => px[(y * W + x) * 4]!;
  check("the geometry's depth reads back", Math.abs(at(stored, 32, 32) - 64) < 6, at(stored, 32, 32));
  check("and the background is the far plane", at(stored, 2, 2) === 255, at(stored, 2, 2));
  check("which is nearer than the background", at(stored, 32, 32) < at(stored, 2, 2));
}

// ---------------------------------------------------------------------------
// Bloom
// ---------------------------------------------------------------------------

{
  const bloom = g.bloom({ threshold: 0.8, intensity: 1.5, passes: 2 });
  bloom.resize(64, 64);

  const disc = g.renderPipeline({
    shader: `#include <metal_stdlib>
using namespace metal;
struct V { float4 position [[position]]; float2 uv; };
vertex V vs(uint vid [[vertex_id]]) {
  float2 p = float2((vid << 1) & 2, vid & 2);
  V o; o.position = float4(p * 2.0 - 1.0, 0, 1); o.uv = p; return o;
}
fragment float4 fs(V in [[stage_in]]) {
  return distance(in.uv, float2(0.5)) < 0.1 ? float4(8, 6, 2, 1) : float4(0.02, 0.02, 0.03, 1);
}`,
    format: "rgba16float", cull: "none", label: "hdr disc",
  });

  const out = g.texture({
    width: 64, height: 64, format: "bgra8unorm",
    usage: ["renderTarget", "shaderRead"], storage: "shared",
  });
  g.submit((commands) => {
    const frame = new Frame(commands, { time: 0, dt: 0, index: 0, width: 64, height: 64 });
    frame.render({ target: bloom.scene, clear: [0.02, 0.02, 0.03, 1] }, (p) => p.pipeline(disc).draw(3));
    bloom.apply(frame, out);
  });

  const pixels = out.read();
  // BGRA on the way out.
  const at = (x: number, y: number) => {
    const i = (y * 64 + x) * 4;
    return [pixels[i + 2]!, pixels[i + 1]!, pixels[i]!];
  };
  check("the HDR core survives tone mapping", at(32, 32)[0]! > 200, at(32, 32));
  check("light spills outside the shape it came from", at(32, 22)[0]! > 40, at(32, 22));
  check("the corners stay dark", at(2, 2)[0]! < 40, at(2, 2));
  check("and the spill is warm, as the source was", at(32, 22)[0]! > at(32, 22)[2]!, at(32, 22));
}

// ---------------------------------------------------------------------------
// Shader snippets
// ---------------------------------------------------------------------------

{
  const source = msl`${aces}\n${aces}\n${fbm3}\n${kelvin}`;
  const occurrences = source.split("float3 aces(").length - 1;
  check("an interpolated snippet is emitted once", occurrences === 1, occurrences);
  check("its dependencies come with it",
    source.includes("float noise3(") && source.includes("float hash31("));
  check("declaration order puts dependencies first",
    source.indexOf("float hash31(") < source.indexOf("float noise3("));

  const custom = snippet("twice", `float twice(float x) { return x * 2.0; }`);
  const effect = g.effect({ use: [custom], fragment: `return float4(twice(uv.x), 0, 0, 1);` });
  check("a custom snippet compiles into an effect", !!effect.pipeline);

  // A body cannot declare a function, and saying so beats the compiler's
  // "function definition is not allowed here" pointing at a generated line.
  let message = "";
  try { g.effect(`float twice(float x) { return x; }\nreturn float4(twice(uv.x));`); }
  catch (e) { message = String(e); }
  check("declaring a function in a body explains `use`", message.includes("use:"), message.slice(0, 90));
}

// ---------------------------------------------------------------------------
// Instancing and materials in a scene
// ---------------------------------------------------------------------------

{
  const scene = new Scene3D({
    animate: false, background: "#000000",
    camera: { position: [0, 0, 6], target: [0, 0, 0], fov: 50 },
    light: { direction: [0, 0, 1], ambientIntensity: 0 },
  });

  for (let i = 0; i < 200; i++) {
    scene.add(box({ size: 0.2, position: [(i % 20) - 10, Math.floor(i / 20) - 5, 0], color: "#ffffff" }));
  }
  check("200 nodes of one geometry are one draw call", scene.batchCount === 1, scene.batchCount);

  scene.add(sphere({ radius: 0.3, color: "#ff0000" }));
  check("a second geometry is a second batch", scene.batchCount === 2, scene.batchCount);

  const glow = emissive({ intensity: 4 });
  scene.add(box({ size: 0.2, position: [0, 3, 0], color: "#00ff00", material: glow }));
  check("a material splits the batch even for the same geometry",
    scene.batchCount === 3, scene.batchCount);

  const capture = scene.capture(64, 64);
  const at = (x: number, y: number) => {
    const i = (y * 64 + x) * 4;
    return [capture.pixels[i]!, capture.pixels[i + 1]!, capture.pixels[i + 2]!];
  };
  check("the instanced grid rendered", at(32, 32).some((c) => c > 100), at(32, 32));
  scene.dispose();
}

{
  // A custom material is MSL against the same instanced pipeline.
  const stripes = new Material({
    label: "stripes",
    fragment: `
      float bar = step(0.5, fract(in.uv.x * 8.0));
      return float4(in.color.rgb * bar, 1.0);
    `,
  });
  const scene = new Scene3D({
    animate: false, background: "#000000",
    camera: { position: [0, 0, 2.2], target: [0, 0, 0], fov: 50 },
    light: { direction: [0, 0, 1], ambientIntensity: 0 },
  });
  scene.add(box({ size: 2, color: "#ffffff", material: stripes }));
  const capture = scene.capture(64, 64);
  const row: number[] = [];
  for (let x = 8; x < 56; x++) row.push(capture.pixels[(32 * 64 + x) * 4]!);
  const light = row.filter((v) => v > 128).length;
  const dark = row.filter((v) => v < 128).length;
  check("a custom fragment shader reaches the framebuffer", light > 4 && dark > 4, `${light}/${dark}`);
  check("uvs vary across the face", new Set(row).size > 1);
  scene.dispose();
}

{
  // Instance buffers start at 16 and double. A batch that silently stopped at
  // its initial capacity would render the first sixteen nodes and drop the
  // rest, which reads as "the scene is wrong" rather than as a buffer size.
  const scene = new Scene3D({
    animate: false, background: "#000000",
    camera: { position: [0, 0, 26], target: [0, 0, 0], fov: 55 },
    light: { direction: [0, 0, 1], ambientIntensity: 0 },
  });
  const GRID = 40;
  for (let i = 0; i < GRID * GRID; i++) {
    scene.add(box({
      size: 0.18,
      position: [(i % GRID) * 0.5 - 10, Math.floor(i / GRID) * 0.5 - 10, 0],
      color: "#ffffff",
    }));
  }
  check("1600 nodes are still one draw call", scene.batchCount === 1, scene.batchCount);

  const lit = (c: { pixels: Uint8Array }) => {
    let n = 0;
    for (let i = 0; i < c.pixels.length; i += 4) if (c.pixels[i]! > 40) n++;
    return n;
  };
  const all = lit(scene.capture(128, 128));
  check("the buffer grew past its initial capacity", all > 400, all);

  const again = lit(scene.capture(128, 128));
  check("and a second frame at the same size is identical", again === all, `${all} then ${again}`);

  scene.nodes.slice(64).forEach((n) => { n.visible = false; });
  const some = lit(scene.capture(128, 128));
  check("hiding most of them draws fewer", some > 0 && some < all / 3, `${some} of ${all}`);

  scene.nodes.forEach((n) => { n.visible = true; });
  check("and showing them again draws all of them", lit(scene.capture(128, 128)) === all);
  scene.dispose();
}

{
  // Scene3D skips the inverse-transpose when the scale is uniform and copies
  // the model matrix's rotation instead. That is only valid because the shader
  // normalises, so a shading difference here means the shortcut is wrong.
  const shade = (scale: number | readonly [number, number, number]) => {
    const scene = new Scene3D({
      animate: false, background: "#000000",
      camera: { position: [2.4, 2.0, 2.8], target: [0, 0, 0], fov: 50 },
      light: { direction: [0.4, 0.9, 0.5], intensity: 1, ambientIntensity: 0.2 },
    });
    scene.add(sphere({ radius: 0.5, segments: 24, rings: 16, color: "#ffffff", scale }));
    const c = scene.capture(64, 64);
    const row: number[] = [];
    for (let x = 8; x < 56; x += 2) row.push(c.pixels[(32 * 64 + x) * 4]!);
    scene.dispose();
    return row;
  };

  const plain = shade(1);
  const scaled = shade(2);
  // Same object, twice the size: the shading gradient across it must match.
  const brightest = (r: number[]) => Math.max(...r);
  check("a uniformly scaled object is lit the same as an unscaled one",
    Math.abs(brightest(plain) - brightest(scaled)) < 12,
    `${brightest(plain)} vs ${brightest(scaled)}`);
  check("and it is actually lit, not flat", brightest(plain) > 120 && Math.min(...plain) < 90,
    `${Math.min(...plain)}..${brightest(plain)}`);

  // Non-uniform scale still takes the inverse-transpose path.
  const squashed = shade([1, 0.3, 1]);
  check("a squashed object still shades", brightest(squashed) > 100, brightest(squashed));
}

{
  // Draw order must not depend on the order things were added. A blended
  // surface writes no depth, so an opaque one drawn afterwards erases it —
  // which looks like a shader bug and is an ordering bug.
  const render = (glowFirst: boolean) => {
    const s = new Scene3D({
      animate: false, background: "#000000",
      camera: { position: [0, 0, 6], target: [0, 0, 0], fov: 50 },
      light: { direction: [0, 0, 1], ambientIntensity: 0 },
    });
    const glow = () => s.add(box({
      size: 1.5, position: [0, 0, 1], color: "#00ff00", material: emissive({ intensity: 2 }),
    }));
    const solid = () => s.add(box({ size: 3, position: [0, 0, -1], color: "#ff0000" }));
    if (glowFirst) { glow(); solid(); } else { solid(); glow(); }
    const c = s.capture(48, 48);
    const i = (24 * 48 + 24) * 4;
    const px = [c.pixels[i]!, c.pixels[i + 1]!, c.pixels[i + 2]!];
    s.dispose();
    return px;
  };
  const solidFirst = render(false);
  const glowFirst = render(true);
  check("blended geometry draws after opaque, whatever order it was added in",
    solidFirst.join() === glowFirst.join(), `${solidFirst} vs ${glowFirst}`);
  check("and the additive layer is actually there",
    solidFirst[0]! > 200 && solidFirst[1]! > 200, solidFirst);
}

{
  // Bloom inside a scene: an emissive node has to spill past its own edges.
  const scene = new Scene3D({
    animate: false, background: "#000000",
    camera: { position: [0, 0, 6], target: [0, 0, 0], fov: 50 },
    light: { direction: [0, 0, 1], ambientIntensity: 0 },
    bloom: { threshold: 0.7, intensity: 1.6, passes: 2 },
  });
  check("the scene owns a post chain", scene.post !== null);
  scene.add(sphere({ radius: 0.5, color: "#ffcc44", material: emissive({ intensity: 6 }) }));

  const capture = scene.capture(96, 96);
  const at = (x: number, y: number) => {
    const i = (y * 96 + x) * 4;
    return [capture.pixels[i]!, capture.pixels[i + 1]!, capture.pixels[i + 2]!];
  };
  check("the emissive core is bright", at(48, 48)[0]! > 180, at(48, 48));
  check("it spills past its own silhouette", at(48, 30)[0]! > 25, at(48, 30));
  check("the far corner stays black", at(3, 3)[0]! < 25, at(3, 3));
  scene.dispose();
}

// ---------------------------------------------------------------------------
// The playground's presets
// ---------------------------------------------------------------------------

{
  // Pulled out of the example rather than copied, so this checks what ships.
  // The examples suite only proves the app starts; these are the shaders, and a
  // shader that fails to compile there is a silent red status line nobody sees.
  const source = await Bun.file("examples/shader-playground.ts").text();
  const presets = [...source.matchAll(/\["(\w+)", `([\s\S]*?)`\],/g)];
  check("the presets were found in the example", presets.length >= 4, presets.length);

  const Play = struct("Play", { time: vec4f, resolution: vec4f, mouse: vec4f });
  const W = 48;

  for (const [, name, body] of presets) {
    let colours = 0;
    let error = "";
    try {
      const effect = g.effect({ uniforms: Play, fragment: body!, format: "rgba8unorm", label: name });
      const out = g.texture({
        width: W, height: W, format: "rgba8unorm",
        usage: ["renderTarget", "shaderRead"], storage: "shared",
      });
      g.submit((commands) => {
        const frame = new Frame(commands, { time: 1.4, dt: 1 / 60, index: 84, width: W, height: W });
        frame.effect(effect, {
          to: out,
          bind: {
            u: {
              time: [1.4, 84, 0, 0],
              resolution: [W, W, 1 / W, 1 / W],
              mouse: [W * 0.5, W * 0.4, 1, 0],
            },
          },
        });
      });
      const pixels = out.read();
      const distinct = new Set<string>();
      for (let i = 0; i < pixels.length; i += 4) {
        distinct.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      }
      colours = distinct.size;
    } catch (e) {
      error = String(e).split("\n").slice(0, 3).join(" ");
    }
    // More than a handful of distinct colours: a preset that compiles but
    // returns a constant is not doing what the preset claims.
    check(`the ${name} preset compiles and draws something`, colours > 20, error || colours);
  }
}

// ---------------------------------------------------------------------------
// Capture, across the combinations that change the attachments
// ---------------------------------------------------------------------------

{
  // A multisampled pipeline drawing into single-sampled attachments is a
  // validation error that renders fine until someone turns validation on, so
  // capture has to build attachments matching the view's sample count.
  for (const sampleCount of [1, 4]) {
    for (const bloom of [false, true]) {
      const scene = new Scene3D({
        animate: false, sampleCount, bloom, background: "#000000",
        camera: { position: [0, 0, 4], target: [0, 0, 0] },
        light: { direction: [0, 0, 1], ambientIntensity: 0 },
      });
      scene.add(box({ size: 2, color: "#00ff00" }));
      const c = scene.capture(64, 64);
      const centre = (32 * 64 + 32) * 4;

      // How many pixels along a row through the box sit between background and
      // full green: with MSAA the silhouette is blended, without it is a step.
      let blended = 0;
      for (let x = 0; x < 64; x++) {
        const g = c.pixels[(32 * 64 + x) * 4 + 1]!;
        if (g > 20 && g < 235) blended++;
      }

      const label = `sampleCount ${sampleCount}, bloom ${bloom}`;
      check(`capture works with ${label}`, c.pixels[centre + 1]! > 180, c.pixels[centre + 1]);
      if (sampleCount > 1 && !bloom) {
        check("and multisampling actually resolves an edge", blended >= 1, blended);
      }
      scene.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// AppKit over Metal
// ---------------------------------------------------------------------------

{
  // A HUD is an ordinary control added to the scene. It composites over the
  // Metal layer, which is the whole reason Scene3D is a View rather than a
  // window of its own.
  const scene = new Scene3D({
    grow: 1, animate: false, background: "#101018",
    camera: { position: [0, 1.5, 4], target: [0, 0, 0] },
  });
  scene.add(box({ size: 1.4, color: "#ff2020" }));
  const hud = new Label({ text: "24 fixtures", font: { monospace: true, size: 13 } });
  scene.add(hud);

  const win = new Window({
    title: "overlay", size: { width: 400, height: 300 },
    content: new VStack({ padding: 0 }, [scene]), show: true,
  });
  for (let i = 0; i < 25; i++) pumpOnce(0.004);

  check("a control added to a scene becomes its subview",
    Number(scene.native.subviews().count()) === 1, Number(scene.native.subviews().count()));
  check("and the scene still renders", (() => {
    const c = scene.capture(64, 64);
    return c.pixels[(32 * 64 + 32) * 4]! > 100;
  })());

  // cacheDisplayInRect: replays AppKit's drawing and cannot see a Metal
  // drawable, so it would return a convincing image with the scene missing.
  let refused = "";
  try {
    snapshotWindow(win, `${process.env.TMPDIR ?? "/tmp"}/bunkit-should-not-exist.png`);
  } catch (e) {
    refused = String(e);
  }
  check("snapshotWindow refuses a tree containing Metal", refused.includes("Metal layer"),
    refused.slice(0, 80) || "it did not throw");
  check("and says what to use instead", refused.includes("capture()"));

  win.close();
  scene.dispose();
}

// --- volumes, arrays, views, comparison samplers, and a scene drawn another way ---------
{
  // A 4×4×4 volume of r32float, each cell its own index: written whole, read back whole, and
  // read by a kernel through a texture3d — the shape a fog field takes.
  const volume = g.texture({ type: "3d", width: 4, height: 4, depth: 4, format: "r32float",
    usage: ["shaderRead", "shaderWrite"], label: "volume" });
  const cells = new Float32Array(64).map((_, i) => i);
  volume.write(cells);
  const back = new Float32Array(volume.read().buffer);
  check("a 3D texture round-trips every slice", back.length === 64 && back[37] === 37, back[37]);

  const out = g.texture({ width: 4, height: 4, format: "r32float", usage: ["shaderRead", "shaderWrite"] });
  const slice = g.kernel(msl`
#include <metal_stdlib>
using namespace metal;
kernel void slice(texture3d<float, access::read> volume [[texture(0)]],
                  texture2d<float, access::write> out [[texture(1)]],
                  uint2 id [[thread_position_in_grid]]) {
  out.write(volume.read(uint3(id, 2)), id);
}`);
  g.submit((commands) => {
    const frame = new Frame(commands, { time: 0, dt: 0, index: 0, width: 4, height: 4 });
    frame.compute((pass) => pass.pipeline(slice).bind({ volume, out }).dispatchThreads(4, 4));
  });
  const plane = new Float32Array(out.read().buffer);
  check("dispatchThreads covers a 2D grid exactly, and a kernel reads a 3D texture",
    plane[0] === 32 && plane[15] === 47, [plane[0], plane[15]]);

  // A mip chain, filled on the GPU, and a view of one of its levels.
  const chain = g.texture({ width: 8, height: 8, format: "rgba8unorm", mipmapped: true,
    usage: ["shaderRead", "renderTarget"], label: "chain" });
  check("a full mip chain goes down to 1×1", chain.mipLevels === 4, chain.mipLevels);
  chain.write(new Uint8Array(8 * 8 * 4).fill(200));
  g.submit((commands) => new Frame(commands, { time: 0, dt: 0, index: 0, width: 8, height: 8 }).mipmaps(chain));
  const level2 = chain.read({ level: 2 });
  check("mipmaps() fills the lower levels", level2.length === 16 && level2[0] === 200, level2[0]);
  const view = chain.view({ level: 1 });
  check("a view of level 1 is half the size", view.width === 4 && view.height === 4 && view.mipLevels === 1);

  // A 2D array of depth maps: render into one layer, compare against it.
  const shadows = g.texture({ type: "2dArray", arrayLength: 3, width: 8, height: 8,
    format: "depth32float", usage: ["shaderRead", "renderTarget"], label: "shadows" });
  check("an array texture keeps its layer count", shadows.arrayLength === 3 && shadows.type === "2dArray");
  const layer = shadows.view({ slice: 1 });
  check("one layer of it is a plain 2D texture", layer.type === "2d" && layer.width === 8);
  const compare = g.sampler({ compare: "lessEqual", filter: "linear", mip: "none", address: "zero" });
  check("a comparison sampler is made", !!compare.native);
  const probe = g.texture({ width: 1, height: 1, format: "r32float", usage: ["shaderRead", "shaderWrite"] });
  const shade = g.kernel(msl`
#include <metal_stdlib>
using namespace metal;
kernel void shade(depth2d_array<float> maps [[texture(0)]],
                  texture2d<float, access::write> probe [[texture(1)]],
                  sampler cmp [[sampler(0)]],
                  uint2 id [[thread_position_in_grid]]) {
  // Layer 1 was cleared to 0.25: a reference of 0.2 passes (lit), 0.3 fails (in shadow).
  float lit = maps.sample_compare(cmp, float2(0.5), 1, 0.2);
  float dark = maps.sample_compare(cmp, float2(0.5), 1, 0.3);
  probe.write(float4(lit * 10.0 + dark), id);
}`);
  g.submit((commands) => {
    const frame = new Frame(commands, { time: 0, dt: 0, index: 0, width: 8, height: 8 });
    frame.render({ color: [], depth: shadows, depthSlice: 1, clearDepth: 0.25, storeDepth: true, label: "clear layer" }, () => {});
    frame.compute((pass) => pass.pipeline(shade).bind({ maps: shadows, probe, cmp: compare }).dispatchThreads(1, 1));
  });
  const verdict = new Float32Array(probe.read().buffer)[0];
  check("sample_compare passes the near reference and fails the far one, on the right layer",
    verdict === 10, verdict);

  // A scene with a renderer draws nothing of its own and hands over its camera.
  const scene = new Scene3D({ animate: false, sampleCount: 1, background: "#000000" });
  scene.add(box({ size: 1, color: "#ffffff" }));
  let seen: Float32Array | undefined;
  const flat = g.effect(`return float4(0.0, 1.0, 0.0, 1.0);`);
  scene.renderer = (frame, info) => {
    seen = info.viewProjection;
    frame.effect(flat, { to: frame.resolveTexture ?? frame.colorTexture });
  };
  const shot = scene.capture(16, 16);
  check("a renderer replaces the built-in pass", shot.pixels[(8 * 16 + 8) * 4 + 1] === 255 && shot.pixels[(8 * 16 + 8) * 4] === 0,
    Array.from(shot.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)));
  check("and is handed the camera's matrices", seen !== undefined && seen.length === 16);
  scene.renderer = null;
  const plain = scene.capture(16, 16);
  check("clearing it draws the nodes again", plain.pixels[(8 * 16 + 8) * 4 + 1]! !== 255 || plain.pixels[(8 * 16 + 8) * 4]! > 0);
  scene.dispose();
}

// --- a capture is a moment in the view's timeline, not time zero ----------------------
{
  const scene = new Scene3D({ animate: false, sampleCount: 1 });
  const times: number[] = [];
  scene.onFrame((frame) => times.push(frame.time));
  scene.capture(8, 8);
  scene.capture(8, 8);
  check("consecutive captures are consecutive frames", Math.abs(times[1]! - times[0]! - 1 / 60) < 1e-9, times);
  scene.capture(8, 8, { time: 12.5 });
  check("a capture can be asked for a particular moment", times[2] === 12.5, times[2]);
  scene.capture(8, 8, { dt: 0.1 });
  check("and the next carries on from it", Math.abs(times[3]! - 12.6) < 1e-9, times[3]);
  scene.dispose();
}

// --- a render pass lets go of its attachments once it is encoded ------------------------
{
  // A released render target's memory comes back at once: the pass's descriptors used to hold
  // the texture until the garbage collector reached their wrappers.
  const g = gpu();
  const mb = () => Number(g.device.currentAllocatedSize()) / 1048576;
  const before = mb();
  const target = g.texture({
    width: 4096, height: 4096, format: "rgba16float", storage: "private",
    usage: ["renderTarget", "shaderRead"], label: "released target",
  });
  const depth = g.texture({ width: 4096, height: 4096, format: "depth32float", usage: ["renderTarget"], label: "released depth" });
  g.submit((commands) => {
    new Frame(commands, { time: 0, dt: 1 / 60, index: 0, width: 4096, height: 4096 })
      .render({ color: { texture: target, clear: [0, 0, 0, 1] }, depth, label: "released" }, () => {});
  });
  const held = mb() - before;
  target.native.dispose();
  depth.native.dispose();
  const after = mb() - before;
  check("a render pass's attachments are freed as soon as they are released, not at a collection",
    held > 150 && after < 8, { held, after });
}

console.log(failures === 0 ? "\nALL GPU TESTS PASSED" : `\n${failures} GPU FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
