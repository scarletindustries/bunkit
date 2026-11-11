// GPU timing per pass: the timestamps are read back into groups, and a pass that takes longer
// reads longer.

import { f32, Frame, GPUTimer, gpu, gpuAvailable, timingOf } from "../src/metal/index.ts";
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

{
  // Pure: passes in two groups, one sample the GPU could not take, one overlapping the last.
  const ms = (x: number) => BigInt(Math.round(x * 1e6));
  const stamps = new BigUint64Array([
    ms(10), ms(12), ms(12.5), ms(13), 0xffffffffffffffffn, ms(20), ms(14), ms(17), ms(11), ms(18),
  ]);
  const t = timingOf(stamps, ["a", "b", "b", "a", "b"]);
  // a: 10–12 and 14–17 → 5; b: 12.5–13, and the pass that started at 11 adds only 17–18 → 1.5.
  check("each pass is charged what it added, summed by group", Math.abs(t.groups.a! - 5) < 1e-6 && Math.abs(t.groups.b! - 1.5) < 1e-6, t);
  check("the frame is first start to last end, without the failed pass", Math.abs(t.frameMs - 8) < 1e-6 && t.passes === 4, t);
  check("and the charges sum to it, less the idle gaps", Math.abs(t.groups.a! + t.groups.b! - (t.frameMs - 1.5)) < 1e-6);
  // The frame before ran until 11: this frame's first pass is charged from there.
  const after = timingOf(stamps, ["a", "b", "b", "a", "b"], 11);
  check("the tail of the frame before is not this frame's", Math.abs(after.groups.a! - 4) < 1e-6 && Math.abs(after.frameMs - 7) < 1e-6 && Math.abs(after.endMs - 18) < 1e-6, after);
}

if (!gpuAvailable()) {
  console.log("\nTIMER TESTS SKIPPED");
  process.exit(0);
}
const g = gpu();
const timer = GPUTimer.create(g, { passes: 8, frames: 2 });
if (!timer) {
  console.log("  (this GPU cannot sample timestamps at pass boundaries — skipping)");
  console.log("\nTIMER TESTS SKIPPED");
  process.exit(0);
}
const spin = g.kernel(`#include <metal_stdlib>
using namespace metal;
kernel void spin(device float* o [[buffer(0)]], constant uint& n [[buffer(1)]], uint id [[thread_position_in_grid]]) {
  float x = float(id);
  for (uint i = 0; i < n; i++) x = sin(x) * 1.0001 + 0.1;
  o[id] = x;
}`);
const out = g.array(f32, 65536);
const frame = (heavy: number) => g.submit((commands) => {
  const f = new Frame(commands, { time: 0, dt: 0, index: 0, width: 1, height: 1 });
  const slot = timer.begin(f)!;
  slot.group = "light";
  f.compute((p) => p.pipeline(spin).bind({ o: out, n: new Uint32Array([200]) }).dispatch(65536));
  slot.group = "heavy";
  f.compute((p) => p.pipeline(spin).bind({ o: out, n: new Uint32Array([heavy]) }).dispatch(65536));
});
for (let i = 0; i < 4; i++) frame(20_000);
const t = timer.latest;
check("a frame's passes are read back once the GPU is done with them", !!t && t.passes === 2, t);
check("the heavy pass reads heavier than the light one", !!t && t.groups.heavy! > 4 * t.groups.light!, t);
check("and the frame spans both", !!t && t.frameMs >= t.groups.heavy! && t.frameMs > 0, t);
timer.dispose();

console.log(failures === 0 ? "\nALL TIMER TESTS PASSED" : `\n${failures} TIMER FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
