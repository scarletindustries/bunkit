// MetalFX: the framework loads, the scalers are built for what this device takes and refuse
// what it does not, and a temporal upscale of a still picture converges on that picture.

import { Frame, FrameInterpolator, gpu, gpuAvailable, metalFXAvailable, SpatialScaler, TemporalScaler, usageNames } from "../src/metal/index.ts";
import { initApp } from "../src/runtime.ts";

let failures = 0;
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

initApp();

check("usage masks name their bits", usageNames(7).join(",") === "shaderRead,shaderWrite,renderTarget" && usageNames(1).join(",") === "shaderRead");

if (!gpuAvailable() || !metalFXAvailable(gpu())) {
  console.log("  (no MetalFX here — skipping the scaler checks)");
  console.log(failures === 0 ? "\nMETALFX TESTS SKIPPED" : `\n${failures} METALFX FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

const g = gpu();
const range = TemporalScaler.scaleRange(g);
check("the temporal scaler publishes its scale range", !!range && range[0] >= 1 && range[1] >= 2, range);

const make = (input: [number, number], output: [number, number]) => TemporalScaler.create(g, {
  input, output, color: "rgba16float", depth: "depth32float", motion: "rg16float", outputFormat: "rgba16float",
});
check("a scale past the device's range is refused, not thrown", make([64, 36], [64 * 8, 36 * 8]) === null);
const fx = make([64, 36], [128, 72]);
check("a 2× temporal scaler is built", !!fx);
check("and says which usages its textures need", !!fx && fx.usage.output !== 0 && usageNames(fx.usage.color).includes("shaderRead"), fx?.usage);

if (fx) {
  // A still picture: a horizontal ramp, jittered frames, no motion. The output converges on
  // the ramp at twice the size.
  const color = g.texture({ width: 64, height: 36, format: "rgba16float", usage: ["shaderRead", "shaderWrite", "renderTarget"], storage: "private" });
  const depth = g.texture({ width: 64, height: 36, format: "depth32float", usage: ["shaderRead", "renderTarget"] });
  const motion = g.texture({ width: 64, height: 36, format: "rg16float", usage: ["shaderRead", "renderTarget"], storage: "private" });
  const output = g.texture({ width: 128, height: 72, format: "rgba16float", usage: usageNames(fx.usage.output | 1), storage: "shared" });
  const ramp = g.kernel(`#include <metal_stdlib>
using namespace metal;
kernel void ramp(texture2d<float, access::write> dst [[texture(0)]], constant float2& jitter [[buffer(0)]],
                 uint2 id [[thread_position_in_grid]]) {
  float x = (float(id.x) + 0.5 + jitter.x) / float(dst.get_width());
  dst.write(float4(x, 0.5, 1.0 - x, 1.0), id);
}`);
  for (let i = 0; i < 16; i++) {
    const jitter: [number, number] = [((i * 0.618) % 1) - 0.5, ((i * 0.382) % 1) - 0.5];
    g.submit((commands) => {
      const frame = new Frame(commands, { time: 0, dt: 0, index: i, width: 128, height: 72 });
      frame.render({ color: { texture: motion, clear: [0, 0, 0, 0] }, depth, clearDepth: 0.5, storeDepth: true }, () => {});
      frame.compute((pass) => pass.pipeline(ramp).bind({ dst: color, jitter: new Float32Array(jitter) }).dispatchThreads(64, 36));
      fx.encode(commands, { color, depth, motion, output, jitter, motionScale: [-64, -36], reset: i === 0 });
    });
  }
  const half = new Uint16Array(output.read().buffer);
  const f16 = (h: number) => {
    const e = (h >> 10) & 31, m = h & 1023, s = h >> 15 ? -1 : 1;
    return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15);
  };
  const red = (x: number, y: number) => f16(half[(y * 128 + x) * 4]!);
  const mid = red(64, 36), left = red(16, 36), right = red(112, 36);
  check("a temporal upscale of a still ramp is the ramp, at twice the size", Math.abs(mid - 0.5) < 0.05 && left < 0.25 && right > 0.75, { left, mid, right });
}

const spatial = SpatialScaler.create(g, { input: [64, 36], output: [128, 72], color: "rgba16float", outputFormat: "rgba16float" });
check("a spatial scaler is built", !!spatial);

// Built on a background queue: the call returns at once, the build is polled, and taken once.
{
  const started = performance.now();
  const build = TemporalScaler.build(g, {
    input: [128, 72], output: [128, 72], dynamic: [1, 3],
    color: "rgba16float", depth: "r32float", motion: "rg16float", reactive: "r16float", outputFormat: "rgba16float",
  });
  const held = performance.now() - started;
  check("a background build returns without building on this thread", !!build && held < 15, { held });
  while (build && build.state === "building" && performance.now() - started < 5000) await Bun.sleep(2);
  check("and is ready within seconds", build?.state === "ready", build?.state);
  const scaler = build?.take();
  check("and is taken once", !!scaler && build!.take() === null && build!.state === "done");
  scaler?.dispose();
  const dropped = TemporalScaler.build(g, { input: [64, 36], output: [64, 36], color: "rgba16float", depth: "r32float", motion: "rg16float", outputFormat: "rgba16float" });
  dropped?.cancel();
  check("a build given up is done, and gives nothing", dropped?.state === "done" && dropped?.take() === null);
  check("a dynamic range past the device's is refused, not thrown", TemporalScaler.build(g, { input: [64, 36], output: [64, 36], dynamic: [1, 9], color: "rgba16float", depth: "r32float", motion: "rg16float", outputFormat: "rgba16float" }) === null);
}

// The frame interpolator (macOS 26): built in the background; the frame between two still,
// identical pictures is that picture.
if (FrameInterpolator.available(g)) {
  const build = FrameInterpolator.build(g, { input: [64, 36], output: [64, 36], color: "rgba16float", outputFormat: "rgba16float", depth: "depth32float", motion: "rg16float" });
  const started = performance.now();
  while (build && build.state === "building" && performance.now() - started < 5000) await Bun.sleep(2);
  const fi = build?.take();
  check("a frame interpolator is built in the background", !!fi);
  if (fi) {
    const color = g.texture({ width: 64, height: 36, format: "rgba16float", usage: ["shaderRead", "shaderWrite", "renderTarget"], storage: "private" });
    const depth = g.texture({ width: 64, height: 36, format: "depth32float", usage: ["shaderRead", "renderTarget"] });
    const motion = g.texture({ width: 64, height: 36, format: "rg16float", usage: ["shaderRead", "renderTarget"], storage: "private" });
    const output = g.texture({ width: 64, height: 36, format: "rgba16float", usage: ["shaderRead", "shaderWrite", "renderTarget"], storage: "private" });
    const shared = g.texture({ width: 64, height: 36, format: "rgba16float", usage: ["shaderRead", "shaderWrite"], storage: "shared" });
    const k = g.kernel(`#include <metal_stdlib>
using namespace metal;
kernel void grey(texture2d<float, access::write> dst [[texture(0)]], texture2d<float, access::read> src [[texture(1)]],
                 texture2d<float, access::write> copy [[texture(2)]], constant float& mode [[buffer(0)]], uint2 id [[thread_position_in_grid]]) {
  if (mode < 0.5) dst.write(float4(0.25, 0.25, 0.25, 1.0), id); else copy.write(src.read(id), id);
}`);
    for (let i = 0; i < 3; i++) {
      g.submit((commands) => {
        const frame = new Frame(commands, { time: 0, dt: 0, index: i, width: 64, height: 36 });
        frame.render({ color: { texture: motion, clear: [0, 0, 0, 0] }, depth, clearDepth: 0.5, storeDepth: true }, () => {});
        frame.compute((pass) => pass.pipeline(k).bind({ dst: color, src: output, copy: shared, mode: new Float32Array([0]) }).dispatchThreads(64, 36));
        fi.encode(commands, { color, previous: color, depth, motion, output, motionScale: [-64, -36], jitter: [0, 0], deltaTime: 1 / 60, near: 0.1, far: 100, fov: 50, aspect: 64 / 36, reset: i === 0 });
        frame.compute((pass) => pass.pipeline(k).bind({ dst: color, src: output, copy: shared, mode: new Float32Array([1]) }).dispatchThreads(64, 36));
      });
    }
    const half = new Uint16Array(shared.read().buffer);
    const f16 = (h: number) => {
      const e = (h >> 10) & 31, m = h & 1023, s = h >> 15 ? -1 : 1;
      return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15);
    };
    const v = f16(half[(18 * 64 + 32) * 4]!);
    check("the frame between two identical pictures is that picture", Math.abs(v - 0.25) < 0.02, v);
    fi.dispose();
  }
} else {
  console.log("  (no frame interpolator here — skipping it)");
}

console.log(failures === 0 ? "\nALL METALFX TESTS PASSED" : `\n${failures} METALFX FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
