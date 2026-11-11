// Shader libraries compiled on Metal's threads: shaderAsync resolves to the cached Shader, a
// nonBlocking compile throws CompilePending and lands in the cache, a broken source rejects with
// the compiler's message, and the main thread is not held while Metal compiles.

import { CompilePending, gpu, gpuAvailable, isCompilePending } from "../src/metal/index.ts";
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
  // Pure: what counts as pending.
  check("a CompilePending is one", isCompilePending(new CompilePending("x")));
  check("so is one logged as a string", isCompilePending(String(new CompilePending("x"))));
  check("an ordinary error is not", !isCompilePending(new Error("x")) && !isCompilePending("failed"));
  check("it names itself", new CompilePending("lighting").name === "CompilePending" && new CompilePending("lighting").label === "lighting");
}

if (!gpuAvailable()) {
  console.log("\nCOMPILE TESTS SKIPPED");
  process.exit(0);
}
const g = gpu();

/**
 * A kernel heavy enough that Metal's front end takes a while on it, and unique to this run, so
 * Metal's shader cache has never seen it: an unrolled loop of a hundred helper functions.
 */
function heavySource(tag: string): string {
  const salt = `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  let helpers = "";
  for (let i = 0; i < 120; i++) {
    helpers += `static float h${i}(float x) { float y = x; for (int k = 0; k < 8; k++) { y = sin(y * ${1 + i * 0.01}) + cos(y * float(2 + k)); } return y; }\n`;
  }
  let body = "float v = float(id);\n";
  for (let i = 0; i < 120; i++) body += `  v = h${i}(v);\n`;
  return `#include <metal_stdlib>
using namespace metal;
// ${salt}
${helpers}
kernel void heavy_${tag}(device float* out [[buffer(0)]], uint id [[thread_position_in_grid]]) {
  ${body}
  out[id] = v + ${(Math.random() + 1).toFixed(9)};
}
`;
}

/** Run the event loop until `done` or `ms` pass; returns the longest gap seen between 1 ms ticks. */
async function waitWatching(done: () => boolean, ms: number): Promise<{ ok: boolean; worstGapMs: number }> {
  let last = performance.now();
  let worst = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  const until = performance.now() + ms;
  while (!done() && performance.now() < until) await Bun.sleep(1);
  clearInterval(probe);
  return { ok: done(), worstGapMs: worst };
}

{
  // shaderAsync: resolves to the Shader the cache hands out from then on.
  const source = heavySource("async");
  const started = performance.now();
  const pending = g.shaderAsync(source, { label: "heavy async" });
  const startMs = performance.now() - started;
  check("starting a compile returns at once", startMs < 20, `${startMs.toFixed(1)} ms`);
  let shader: unknown;
  pending.then((s) => { shader = s; });
  const watched = await waitWatching(() => shader !== undefined, 30_000);
  check("it resolves", watched.ok);
  check("the main thread kept running while Metal compiled", watched.worstGapMs < 50, `${watched.worstGapMs.toFixed(1)} ms`);
  check("and the cache hands out the same Shader", g.shader(source) === shader);
  const pipeline = g.kernel({ shader: shader as never, entry: "heavy_async" });
  check("which makes a working pipeline", pipeline.maxThreads > 0);
  check("nothing is left compiling", g.compiling === 0);
  check("asking again resolves to it at once", (await g.shaderAsync(source)) === shader);
}

{
  // nonBlocking: a miss throws CompilePending and starts the compile — the library, and with it
  // (new code, so new GPU code) its kernels' states — counted, none holding this thread.
  const source = heavySource("deferred");
  const before = g.deferred;
  const make = () => g.nonBlocking(() => g.kernel({ shader: source, entry: "heavy_deferred", label: "heavy deferred" }));
  let kernel: ReturnType<typeof make> | undefined;
  let first: unknown;
  let worstHold = 0;
  let worstGap = 0;
  let attempts = 0;
  while (!kernel && attempts < 20) {
    attempts++;
    const t = performance.now();
    try {
      kernel = make();
    } catch (e) {
      if (!(e instanceof CompilePending)) throw e;
      first ??= e;
    }
    worstHold = Math.max(worstHold, performance.now() - t);
    if (!kernel) {
      check(`attempt ${attempts}: something is compiling`, g.compiling >= 1);
      const watched = await waitWatching(() => g.compiling === 0, 30_000);
      worstGap = Math.max(worstGap, watched.worstGapMs);
    }
  }
  check("a shader not compiled yet throws CompilePending inside nonBlocking", first instanceof CompilePending, first);
  check("no attempt waits for the compiler", worstHold < 25, `${worstHold.toFixed(1)} ms`);
  check("the main thread kept running while Metal compiled", worstGap < 50, `${worstGap.toFixed(1)} ms`);
  check("every deferral is counted", g.deferred - before === attempts - 1 && attempts >= 2, { attempts, deferred: g.deferred - before });
  // The kernel's state was compiled as soon as its library was, before anyone asked for it: one
  // deferral (the library), not two.
  check("a kernel's state is compiled with its library", attempts === 2, { attempts });
  check("and trying again once it is compiled succeeds", kernel !== undefined && kernel.maxThreads > 0);
  // The same pipeline again, warm, inside nonBlocking: made at once, nothing put off.
  const d = g.deferred;
  const t = performance.now();
  const again = make();
  const againMs = performance.now() - t;
  check("a warm pipeline is made inside nonBlocking without a deferral", again.maxThreads > 0 && g.deferred === d);
  check("in a few milliseconds", againMs < 10, `${againMs.toFixed(1)} ms`);
  // Outside nonBlocking nothing changes: a new source compiles here, as it always has.
  const plain = heavySource("plain");
  const sync = g.shader(plain);
  check("outside it, shader() still compiles on this thread", sync && g.compiling === 0 && g.deferred === d);
}

{
  // A source that does not compile: shaderAsync rejects with the compiler's message, and a
  // nonBlocking retry throws that error rather than CompilePending again.
  const broken = `#include <metal_stdlib>\nusing namespace metal;\nkernel void broken_${Date.now()}(device float* o [[buffer(0)]]) { o[0] = undefined_thing; }\n`;
  let message = "";
  await g.shaderAsync(broken, { label: "broken" }).catch((e: Error) => { message = e.message; });
  check("a broken source rejects with the compiler's message", message.includes("broken failed to compile") && message.includes("undefined_thing"), message);
  let thrown: unknown;
  try {
    g.nonBlocking(() => g.shader(broken, { label: "broken" }));
  } catch (e) {
    thrown = e;
  }
  check("and a retry throws that, not CompilePending", thrown instanceof Error && !(thrown instanceof CompilePending) && String((thrown as Error).message).includes("undefined_thing"), thrown);
}

{
  // Many at once: they all land, and two asks for one source share one compile.
  const sources = [0, 1, 2, 3].map((i) => heavySource(`many${i}`));
  const both = [g.shaderAsync(sources[0]!), g.shaderAsync(sources[0]!)];
  check("two asks for one source are one compile", g.compiling <= 4);
  const all = await Promise.all([...both, ...sources.slice(1).map((s) => g.shaderAsync(s))]);
  check("every one lands", all.every((s) => s && s.native));
  check("and the two asks got the same Shader", all[0] === all[1]);
}

console.log(failures === 0 ? "\nCOMPILE TESTS PASSED" : `\n${failures} COMPILE TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
