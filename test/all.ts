// Run every suite in its own process.
//
// Each suite drives a real NSApplication, and NSApplication is a per-process
// singleton whose state (menu bar, key window, activation) leaks between suites
// — so they must not share one.

import { spawn } from "bun";

const SUITES = [
  "test/layer2.ts",
  "test/edge.ts",
  "test/constants.ts",
  "test/types-check.ts",
  "test/layout.ts",
  "test/chrome.ts",
  "test/metal.ts",
  "test/gpu.ts",
  "test/compile.ts",
  "test/input.ts",
  "test/keys.ts",
  "test/runloop.ts",
  "test/soak.ts",
  "test/perf.ts",
  "test/examples.ts",
];

let failed = 0;
const results: Array<[string, boolean, number]> = [];

for (const suite of SUITES) {
  process.stdout.write(`\n=== ${suite} ${"=".repeat(Math.max(0, 60 - suite.length))}\n`);
  const t0 = performance.now();
  const proc = spawn({
    cmd: ["bun", "run", suite],
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  const dt = (performance.now() - t0) / 1000;
  results.push([suite, code === 0, dt]);
  if (code !== 0) failed++;
}

console.log("\n" + "=".repeat(66));
for (const [suite, ok, dt] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${suite.padEnd(24)} ${dt.toFixed(1)}s`);
}
console.log(failed === 0 ? "\nALL SUITES PASSED" : `\n${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
