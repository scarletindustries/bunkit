// The numbers the README and the docs quote, asserted so they cannot drift.
//
// This exists because they did drift. An earlier version of the docs claimed
// 20,000 instance structs cost 0.05ms, off by fifty times, and nothing caught
// it — the frame still rendered, so every test stayed green while the advice
// the documentation gave about how to structure a scene was wrong.
//
// The budgets are loose and one-sided. They are not benchmarks; they are a
// guard against a change that makes the per-object path an order of magnitude
// worse, which is the only kind of regression a number in a README can hide.

import { Scene3D, box, gpu, gpuAvailable, mat4x4f, struct, vec4f, Frame } from "../src/metal/index.ts";
import { compose, normalMatrix } from "../src/metal/math.ts";
import { VStack, Window } from "../src/ui/index.ts";
import { initApp, pumpOnce } from "../src/runtime.ts";

let failures = 0;
function check(name: string, cond: any, extra?: any) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/*
 * A shared CI runner is virtualised and contended, and its GPU is not the one
 * the quoted figures were measured on. The budgets there are wide enough to
 * pass on a bad day and still catch something being ten times slower.
 */
const CI = !!Bun.env.CI;
const SLACK = CI ? 6 : 2;

initApp();

// ---------------------------------------------------------------------------
// The main loop (docs/main-loop/spec.md §11, test 8): the pump costs what v1's did, events are
// as quick to arrive, and a turn's fixed cost is small and written down.
// ---------------------------------------------------------------------------
//
// v1, measured on an M2 Pro (macOS 26.6.2, Bun 1.4.4) back to back with the main loop, alternating
// runs of each: br_pump(0) 2.07–2.09 µs against 2.08–2.10 µs (2.33 µs while the nesting observer
// also watched the default mode the pump waits in); an event posted from a Bun timer reaching a
// monitor under run(), 0.17–0.24 ms median against 0.14–0.30 ms — the same spread, which is the
// machine's, so the budget allows for it.
{
  const { pumpOnce, MainLoop, run, quit } = await import("../src/runtime.ts");
  const { lib } = await import("../src/bridge.ts");
  const { objc, createBlock } = await import("../src/objc.ts");
  const win = new Window({ title: "pump", size: { width: 320, height: 200 }, show: true });
  for (let i = 0; i < 60; i++) {
    pumpOnce(0.002);
    await Bun.sleep(2);
  }
  const N = 20_000;
  const pumpUs = median(7, () => {
    const t = performance.now();
    for (let i = 0; i < N; i++) pumpOnce(0);
    return ((performance.now() - t) * 1000) / N;
  });
  check(`a pump with nothing to do costs ${pumpUs.toFixed(2)}us, v1's 2.06us or near it (under ${(2.6 * (CI ? 3 : 1)).toFixed(1)}us)`,
    pumpUs < 2.6 * (CI ? 3 : 1), pumpUs);

  // A turn's fixed cost: the source firing inside the pump, the call into JavaScript and back,
  // the checks for work, and the deadline left as it was. Measured at 0.3 µs.
  const turnUs = median(7, () => {
    const t = performance.now();
    for (let i = 0; i < N; i++) {
      lib.br_main_signal();
      pumpOnce(0);
    }
    return ((performance.now() - t) * 1000) / N;
  }) - pumpUs;
  check(`an empty main-loop turn costs ${turnUs.toFixed(2)}us on top of the pump (under ${(2 * SLACK).toFixed(0)}us)`,
    turnUs < 2 * SLACK, turnUs);

  // A task, with its checkpoint (process.nextTick, then drainMicrotasks): measured at 0.15 µs.
  const taskUs = median(7, () => {
    const M = 2000;
    let n = 0;
    for (let i = 0; i < M; i++) MainLoop.post(() => void n++);
    const t = performance.now();
    while (n < M) pumpOnce(0);
    return ((performance.now() - t) * 1000) / M;
  });
  check(`a posted task, run with its checkpoint, costs ${taskUs.toFixed(2)}us (under ${SLACK.toFixed(0)}us)`,
    taskUs < SLACK, taskUs);

  // Event latency under run(): an application-defined event posted from a Bun timer, to the
  // moment a local monitor sees it.
  const app = objc.NSApplication.sharedApplication();
  const latencies: number[] = [];
  let sentAt = 0;
  const monitor = createBlock("@@?@", (e: any) => {
    if (Number(e.subtype()) === 7) latencies.push(performance.now() - sentAt);
    return e;
  });
  const token = objc.NSEvent.addLocalMonitorForEventsMatchingMask_handler_(1n << 15n, monitor);
  let posted = 0;
  const iv = setInterval(() => {
    if (posted++ < 200) {
      sentAt = performance.now();
      app.postEvent_atStart_(
        objc.NSEvent.otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2_(
          15, { x: 0, y: 0 }, 0, 0, 0, null, 7, 0, 0),
        false);
    } else {
      clearInterval(iv);
      quit();
    }
  }, 7);
  await run({ quitAfterLastWindow: false });
  objc.NSEvent.removeMonitor_(token);
  monitor.dispose();
  latencies.sort((a, b) => a - b);
  const latency = latencies[latencies.length >> 1]!;
  console.log(`  (event latency under run(): median ${latency.toFixed(3)} ms, p90 ${latencies[Math.floor(latencies.length * 0.9)]!.toFixed(3)} ms; v1 0.17–0.24 ms)`);
  check(`an event reaches JavaScript in ${latency.toFixed(3)}ms median, within v1's spread (under ${(0.5 * (CI ? 4 : 1)).toFixed(1)}ms)`,
    latency < 0.5 * (CI ? 4 : 1), latency);
  win.close();
}

if (!gpuAvailable()) {
  console.log("  (no Metal device here — skipping)");
  console.log("\nPERFORMANCE TESTS SKIPPED");
  process.exit(0);
}

const g = gpu();

/** Median of several runs, so one scheduling hiccup does not fail the suite. */
function median(runs: number, fn: () => number): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) times.push(fn());
  times.sort((a, b) => a - b);
  return times[times.length >> 1]!;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

{
  const N = 100_000;
  const p = { x: 1, y: 2, z: 3 };
  const r = { x: 0.3, y: 0.6, z: 0.1 };
  const s = { x: 1, y: 1, z: 1 };
  const m = new Float32Array(16);
  const n = new Float32Array(16);

  for (let i = 0; i < N; i++) compose(p, r, s, m);
  const composeUs = median(5, () => {
    const t = performance.now();
    for (let i = 0; i < N; i++) compose(p, r, s, m);
    return ((performance.now() - t) * 1000) / N;
  });
  // Documented at 0.03us. Built out of four matrix multiplies it was 0.27us,
  // so the budget sits well below that: this fails if anyone rebuilds it.
  check(`compose costs ${composeUs.toFixed(4)}us, under ${(0.09 * SLACK).toFixed(2)}us`,
    composeUs < 0.09 * SLACK, composeUs);

  for (let i = 0; i < N; i++) normalMatrix(m, n);
  const normalUs = median(5, () => {
    const t = performance.now();
    for (let i = 0; i < N; i++) normalMatrix(m, n);
    return ((performance.now() - t) * 1000) / N;
  });
  check(`normalMatrix costs ${normalUs.toFixed(4)}us, under ${(0.12 * SLACK).toFixed(2)}us`,
    normalUs < 0.12 * SLACK, normalUs);
}

// ---------------------------------------------------------------------------
// Writing instance data
// ---------------------------------------------------------------------------

{
  const Inst = struct("Inst", {
    model: mat4x4f, normalMatrix: mat4x4f, color: vec4f, params: vec4f,
  });
  const N = 20_000;
  const array = g.array(Inst, N);
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;

  const schemaUs = median(5, () => {
    const t = performance.now();
    for (let i = 0; i < N; i++) {
      array.set(i, { model: m, normalMatrix: m, color: [1, 0, 0, 1], params: [1, 0, 0, 0] });
    }
    return ((performance.now() - t) * 1000) / N;
  });
  check(`a schema write costs ${schemaUs.toFixed(4)}us, under ${(0.25 * SLACK).toFixed(2)}us`,
    schemaUs < 0.25 * SLACK, schemaUs);

  const floats = array.floats();
  const stride = array.stride / 4;
  const directUs = median(5, () => {
    const t = performance.now();
    for (let i = 0; i < N; i++) {
      const o = i * stride;
      floats.set(m, o);
      floats.set(m, o + 16);
      floats[o + 32] = 1; floats[o + 35] = 1;
      floats[o + 36] = 1;
    }
    return ((performance.now() - t) * 1000) / N;
  });
  check(`a direct write costs ${directUs.toFixed(4)}us, under ${(0.05 * SLACK).toFixed(2)}us`,
    directUs < 0.05 * SLACK, directUs);
  // The whole reason Scene3D fills its buffers by hand rather than through
  // the schema. If this stops being true, that code should go back to set().
  check("direct writes are cheaper than the schema", directUs < schemaUs,
    `${directUs.toFixed(4)} vs ${schemaUs.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// Encoding draws
// ---------------------------------------------------------------------------

{
  const Inst = struct("Inst", { color: vec4f });
  const array = g.array(Inst, 4);
  const pipeline = g.renderPipeline({
    shader: `#include <metal_stdlib>
using namespace metal;
struct Inst { float4 color; };
vertex float4 vs(uint vid [[vertex_id]], device const Inst *inst [[buffer(0)]]) {
  return float4(inst[0].color.x * 0.0 + float(vid % 3) * 0.001, 0, 0, 1);
}
fragment float4 fs() { return 1; }`,
    format: "rgba8unorm", depthFormat: null, cull: "none", label: "encode bench",
  });
  const target = g.texture({
    width: 16, height: 16, format: "rgba8unorm", usage: ["renderTarget"], storage: "private",
  });

  const DRAWS = 20_000;
  const drawUs = median(3, () => {
    const t = performance.now();
    g.submit((commands) => {
      const frame = new Frame(commands, { time: 0, dt: 0, index: 0, width: 16, height: 16 });
      frame.render({ color: { texture: target, clear: [0, 0, 0, 1] } }, (pass) => {
        pass.pipeline(pipeline);
        for (let i = 0; i < DRAWS; i++) {
          pass.bind({ inst: array });
          pass.draw(3);
        }
      });
    });
    return ((performance.now() - t) * 1000) / DRAWS;
  });
  // Documented at about 1.2us including the bind. This is the number the whole
  // "instance, do not iterate" argument rests on.
  check(`a bound draw costs ${drawUs.toFixed(2)}us, under ${(2.5 * SLACK).toFixed(1)}us`,
    drawUs < 2.5 * SLACK, drawUs);
}

// ---------------------------------------------------------------------------
// A whole scene frame
// ---------------------------------------------------------------------------

{
  const N = 20_000;
  const scene = new Scene3D({
    animate: false, background: "#000000", maxInstances: 200_000, grow: 1,
    camera: { position: [0, 0, 60], target: [0, 0, 0] },
    light: { direction: [0, 0, 1] },
  });
  for (let i = 0; i < N; i++) {
    scene.add(box({
      size: 0.2,
      position: [(i % 320) * 0.14 - 22, Math.floor(i / 320) * 0.14 - 22, 0],
      color: "#ffffff",
    }));
  }
  check(`${N} nodes of one shape are one draw call`, scene.batchCount === 1, scene.batchCount);

  // draw() needs a real drawable, so this needs a window on screen.
  const win = new Window({
    title: "perf", size: { width: 900, height: 600 },
    content: new VStack({ padding: 0 }, [scene]), show: true,
  });
  for (let i = 0; i < 30; i++) pumpOnce(0.004);

  for (let i = 0; i < 20; i++) scene.draw(i / 60, 1 / 60);
  let cpu = 0;
  let frames = 0;
  for (let i = 0; i < 40; i++) {
    scene.draw(i / 60, 1 / 60);
    cpu += scene.stats.cpuMs;
    frames++;
  }
  const msPerFrame = cpu / frames;
  const usPerNode = (msPerFrame * 1000) / N;

  // Documented as 2.3ms for 20,000 nodes, 0.08us each. The budget is the
  // frame itself: past 16ms of JavaScript this cannot hold 60fps at all.
  check(`${N} nodes cost ${msPerFrame.toFixed(2)}ms of JS per frame, under ${(4 * SLACK).toFixed(0)}ms`,
    msPerFrame < 4 * SLACK, msPerFrame);
  check(`which is ${usPerNode.toFixed(3)}us per node, under ${(0.2 * SLACK).toFixed(2)}us`,
    usPerNode < 0.2 * SLACK, usPerNode);
  // The point of the stat split: this must not be counting the vsync wait.
  check("cpuMs excludes the wait for a drawable", scene.stats.cpuMs < 16,
    `cpu ${scene.stats.cpuMs.toFixed(2)}ms, wait ${scene.stats.waitMs.toFixed(2)}ms`);
  // Command buffers are retired from draw() as well as from the tick, so a
  // caller driving frames by hand still gets timings and does not leak them.
  check("gpuMs is populated even when frames are driven by hand",
    scene.stats.gpuMs > 0, scene.stats.gpuMs);

  scene.dispose();
  win.close();
}

console.log(
  failures === 0 ? "\nALL PERFORMANCE TESTS PASSED" : `\n${failures} PERFORMANCE FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
