// Entry point for `bun test`. Every suite is a separate process — NSApplication
// is a per-process singleton and its state leaks between suites otherwise.

import { expect, test } from "bun:test";
import { spawn } from "bun";

const SUITES = [
  "test/layer2.ts",
  "test/edge.ts",
  "test/constants.ts",
  "test/types-check.ts",
  "test/layout.ts",
  "test/chrome.ts",
  "test/dialogs.ts",
  "test/metal.ts",
  "test/gpu.ts",
  "test/compile.ts",
  "test/metalfx.ts",
  "test/timer.ts",
  "test/input.ts",
  "test/keys.ts",
  "test/runloop.ts",
  "test/net.ts",
  "test/soak.ts",
  "test/net-soak.ts",
  "test/perf.ts",
  "test/examples.ts",
  "test/icon.ts",
];

for (const suite of SUITES) {
  test(suite, async () => {
    const proc = spawn({ cmd: ["bun", "run", suite], stdout: "inherit", stderr: "inherit" });
    expect(await proc.exited).toBe(0);
  }, 120_000);
}
