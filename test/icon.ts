// The bundler's .icon support: an Icon Composer package compiled by Xcode's actool into the
// Assets.car macOS 26 renders as Liquid Glass, plus the .icns fallback. Skipped where Xcode's
// actool is not installed — compiling a .icon needs it, and nothing else in BunKit does.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileIcon } from "../tools/bundle.ts";

let failures = 0;
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const actool = Bun.spawnSync(["xcrun", "--find", "actool"], { stdout: "pipe", stderr: "pipe" });
if (actool.exitCode !== 0) {
  console.log("  skip .icon: no actool (Xcode 26 is needed to compile one)");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "bunkit-icon-test-"));
try {
  // The smallest real .icon: a gradient fill and one glass layer.
  const icon = join(work, "Test.icon");
  mkdirSync(join(icon, "Assets"), { recursive: true });
  writeFileSync(
    join(icon, "Assets", "dot.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="200" fill="#FFB45E"/></svg>`,
  );
  writeFileSync(
    join(icon, "icon.json"),
    JSON.stringify({
      fill: { "linear-gradient": ["srgb:0.1,0.12,0.2,1", "srgb:0.02,0.02,0.04,1"] },
      groups: [{ layers: [{ glass: true, "image-name": "dot.svg", name: "Dot" }] }],
      "supported-platforms": { squares: "shared" },
    }),
  );
  const resources = join(work, "Resources");
  mkdirSync(resources);
  compileIcon(icon, resources, "11.0", false);
  const car = join(resources, "Assets.car");
  const icns = join(resources, "AppIcon.icns");
  check("Assets.car is written, named AppIcon whatever the .icon is called", existsSync(car) && statSync(car).size > 10_000);
  check("and an .icns for older systems", existsSync(icns) && statSync(icns).size > 1_000);

  // A .icon actool refuses is an error that says so, not a bundle without an icon.
  const broken = join(work, "Broken.icon");
  mkdirSync(broken);
  writeFileSync(join(broken, "icon.json"), "{ not json");
  let threw = "";
  try {
    compileIcon(broken, resources, "11.0", false);
  } catch (e) {
    threw = String(e);
  }
  check("a .icon actool cannot read throws", threw.length > 0, threw);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nicon: all passed");
