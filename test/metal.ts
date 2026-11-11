// Metal: the maths, the geometry, and what actually lands in the framebuffer.
//
// Rendering is checked by reading pixels back from an off-screen target, so
// every claim here is about what the GPU produced rather than what the API was
// asked to do. Scene3D.capture() is the same code path the on-screen view uses.

import {
  Scene3D,
  box,
  boxGeometry,
  compose,
  coneGeometry,
  cylinderGeometry,
  geometry,
  identity,
  invert,
  lookAt,
  mat4,
  gpuAvailable,
  insetPerspective,
  multiply,
  normalMatrix,
  perspective,
  mesh,
  plane,
  planeGeometry,
  radians,
  sphere,
  sphereGeometry,
  v3normalize,
  Vertex,
  VERTEX_STRIDE,
  PresentTracker,
  DROP_AFTER_MS,
  ASSUMED_LATENCY_MS,
  MIN_PRESENT_SAMPLES,
  screenLatencyMs,
  material,
  emissive,
} from "../src/metal/index.ts";
import { HStack, VStack, Window } from "../src/ui/index.ts";
import { initApp, pumpOnce } from "../src/runtime.ts";

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

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------
{
  const i = mat4();
  check("identity is identity", i[0] === 1 && i[5] === 1 && i[10] === 1 && i[15] === 1 && i[1] === 0);

  const a = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1]);
  const viaIdentity = multiply(a, mat4());
  check("m * I === m", [...viaIdentity].every((v, k) => close(v, a[k]!)));

  // multiply(out === a) must not read its own partial results.
  const aliased = new Float32Array(a);
  multiply(aliased, aliased, aliased);
  const expected = multiply(a, a);
  check("multiply is alias-safe", [...aliased].every((v, k) => close(v, expected[k]!)));

  const inv = invert(a);
  const round = multiply(a, inv);
  check("m * m^-1 === I", [...round].every((v, k) => close(v, mat4()[k]!, 1e-3)), [...round]);
  check("a singular matrix inverts to identity, not NaN",
    [...invert(new Float32Array(16))].every((v, k) => v === identity(new Float32Array(16))[k]));

  // A point on the near plane must land at z = 0 in Metal's clip space, not -1.
  const p = perspective(radians(60), 1, 0.1, 100);
  const near = [0, 0, -0.1, 1];
  const z = p[2]! * near[0]! + p[6]! * near[1]! + p[10]! * near[2]! + p[14]! * near[3]!;
  const w = p[3]! * near[0]! + p[7]! * near[1]! + p[11]! * near[2]! + p[15]! * near[3]!;
  check("near plane maps to z=0 (Metal clip space, not GL)", close(z / w, 0, 1e-3), z / w);

  // Content under glass: the projection is fitted to what is not covered. Where a point
  // lands on screen, in points from the top left, for a view 1000×600.
  const screen = (m: Float32Array, at: [number, number, number]) => {
    const cx = m[0]! * at[0] + m[4]! * at[1] + m[8]! * at[2] + m[12]!;
    const cy = m[1]! * at[0] + m[5]! * at[1] + m[9]! * at[2] + m[13]!;
    const cw = m[3]! * at[0] + m[7]! * at[1] + m[11]! * at[2] + m[15]!;
    return { x: (cx / cw * 0.5 + 0.5) * 1000, y: (1 - (cy / cw * 0.5 + 0.5)) * 600 };
  };
  const none = insetPerspective(radians(50), 1000, 600, { top: 0, left: 0, bottom: 0, right: 0 }, 0.1, 100);
  const plain = perspective(radians(50), 1000 / 600, 0.1, 100);
  check("with no insets it is the plain perspective", [...none].every((v, k) => close(v, plain[k]!, 1e-6)));
  // A sidebar 250 wide on the left and a toolbar 50 tall: the visible rect is 250..1000 × 50..600.
  const inset = insetPerspective(radians(50), 1000, 600, { top: 50, left: 250, bottom: 0, right: 0 }, 0.1, 100);
  const ahead = screen(inset, [0, 0, -10]);
  check("straight ahead lands in the middle of what is visible", close(ahead.x, 625, 1e-2) && close(ahead.y, 325, 1e-2), ahead);
  const edge = Math.tan(radians(25)) * 10;
  const top = screen(inset, [0, edge, -10]);
  check("and the field of view spans the visible height", close(top.y, 50, 1e-2), top);

  // Looking down -Z from the origin puts the target straight ahead.
  const v = lookAt({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const tz = v[2]! * 0 + v[6]! * 0 + v[10]! * 0 + v[14]!;
  check("lookAt puts the target 5 in front", close(tz, -5, 1e-3), tz);

  // Under non-uniform scale the model matrix alone bends normals; the normal
  // matrix is what keeps them perpendicular to the surface.
  const squash = new Float32Array([1, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const n = normalMatrix(squash);
  const tilted = v3normalize({ x: 1, y: 1, z: 0 });
  const byModel = v3normalize({
    x: squash[0]! * tilted.x, y: squash[5]! * tilted.y, z: squash[10]! * tilted.z,
  });
  const byNormal = v3normalize({
    x: n[0]! * tilted.x, y: n[5]! * tilted.y, z: n[10]! * tilted.z,
  });
  // aimAt has to agree with compose()'s Euler order exactly. A wrong yaw sign
  // still produces a plausible-looking rotation, so check where it points.
  for (const target of [{ x: 3, y: -5, z: 2 }, { x: -4, y: -8, z: -1 }, { x: 6, y: -2, z: -6 }]) {
    const node = mesh({ vertices: new Float32Array(0), indices: new Uint32Array(0) });
    node.aimAt(target);
    const m = compose(node.position, node.rotation, node.scale);
    // The local -Y axis, transformed: column 1 of the rotation, negated.
    const pointing = { x: -m[4]!, y: -m[5]!, z: -m[6]! };
    const want = v3normalize(target);
    check(`aimAt points -Y at ${target.x},${target.y},${target.z}`,
      close(pointing.x, want.x, 1e-3) && close(pointing.y, want.y, 1e-3) &&
      close(pointing.z, want.z, 1e-3),
      `got ${pointing.x.toFixed(3)},${pointing.y.toFixed(3)},${pointing.z.toFixed(3)}`);
  }

  check("normal matrix differs from the model matrix under squash",
    Math.abs(byModel.y - byNormal.y) > 0.2, `${byModel.y} vs ${byNormal.y}`);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
{
  const g = boxGeometry({ size: [2, 4, 6] });
  check("box has 24 vertices and 36 indices",
    g.vertices.length / 8 === 24 && g.indices.length === 36, g.vertices.length / 8);
  check("the vertex schema matches the buffer stride", Vertex.size === VERTEX_STRIDE,
    `${Vertex.size} vs ${VERTEX_STRIDE}`);

  let min = [9, 9, 9], max = [-9, -9, -9];
  for (let i = 0; i < g.vertices.length; i += 8) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, g.vertices[i + k]!);
      max[k] = Math.max(max[k]!, g.vertices[i + k]!);
    }
  }
  check("box is centred and correctly sized",
    close(min[0]!, -1) && close(max[1]!, 2) && close(max[2]!, 3), `${min} ${max}`);

  const unit = (gg: { vertices: Float32Array }) => {
    for (let i = 3; i < gg.vertices.length; i += 8) {
      if (Math.abs(Math.hypot(gg.vertices[i]!, gg.vertices[i + 1]!, gg.vertices[i + 2]!) - 1) > 1e-4) {
        return false;
      }
    }
    return true;
  };
  check("box normals are unit length", unit(g));
  check("sphere normals are unit length", unit(sphereGeometry({ segments: 12, rings: 8 })));
  check("plane normals are unit length", unit(planeGeometry({ segments: 3 })));

  const inRange = (gg: { vertices: Float32Array; indices: Uint32Array }) =>
    [...gg.indices].every((i) => i < gg.vertices.length / 8);
  check("every index is in range",
    inRange(g) && inRange(sphereGeometry()) && inRange(planeGeometry()) &&
    inRange(cylinderGeometry()) && inRange(coneGeometry()));
  check("cylinder and cone normals are unit length",
    unit(cylinderGeometry({ segments: 8 })) && unit(coneGeometry({ segments: 8 })));

  // A cone's apex sits at the origin, so a node's position is the fixture and
  // the mouth is where the beam lands. Getting this inverted renders a beam
  // that is widest at the lamp, which reads as obviously wrong but tests as
  // fine unless the check is about radius rather than extent.
  const c = coneGeometry({ radius: 1, height: 4 });
  let lowest = 0, highest = -99, radiusAtApex = 0, radiusAtMouth = 0;
  for (let i = 0; i < c.vertices.length; i += 8) {
    const y = c.vertices[i + 1]!;
    const r = Math.hypot(c.vertices[i]!, c.vertices[i + 2]!);
    lowest = Math.min(lowest, y);
    highest = Math.max(highest, y);
    if (close(y, 0, 1e-3)) radiusAtApex = Math.max(radiusAtApex, r);
    if (close(y, -4, 1e-3)) radiusAtMouth = Math.max(radiusAtMouth, r);
  }
  check("cone spans from the origin down to -height",
    close(highest, 0) && close(lowest, -4), `${lowest}..${highest}`);
  check("its point is at the origin and its mouth at the bottom",
    close(radiusAtApex, 0, 1e-3) && close(radiusAtMouth, 1),
    `apex r=${radiusAtApex}, mouth r=${radiusAtMouth}`);

  // Normals derived from the winding of a single triangle facing +Z.
  const derived = geometry({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] });
  check("normals are computed when not supplied",
    close(derived.vertices[5]!, 1), [...derived.vertices.slice(3, 6)]);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
if (!gpuAvailable()) {
  console.log("\n  (no Metal device here — skipping the rendering checks)");
} else {
  const pixel = (c: { width: number; pixels: Uint8Array }, x: number, y: number) => {
    const i = (y * c.width + x) * 4;
    return [c.pixels[i]!, c.pixels[i + 1]!, c.pixels[i + 2]!] as [number, number, number];
  };

  // The clear colour reaches the framebuffer untouched.
  {
    const s = new Scene3D({ background: "#123456", animate: false });
    const c = s.capture(64, 64);
    check("capture returns the requested size", c.width === 64 && c.pixels.length === 64 * 64 * 4);
    check("background is the clear colour", pixel(c, 2, 2).join(",") === "18,52,86", pixel(c, 2, 2));
    s.dispose();
  }

  // A white sphere lit head-on with no ambient must come back white. This is
  // the check that catches inverted winding: culled front faces leave the
  // inside of the sphere facing away from the light, and it renders black.
  {
    const s = new Scene3D({
      background: "#000000", animate: false,
      camera: { position: [0, 0, 3], target: [0, 0, 0], fov: 50 },
      light: { direction: [0, 0, 1], intensity: 1, ambientIntensity: 0 },
    });
    s.add(sphere({ radius: 1, color: "#ffffff" }));
    const c = s.capture(96, 96);
    check("sphere winding faces outward", pixel(c, 48, 48)[0] > 200, pixel(c, 48, 48));
    s.dispose();
  }

  for (const [name, node] of [
    ["box", box({ size: 2, color: "#ffffff" })],
    ["plane", plane({ size: 8, color: "#ffffff" })],
  ] as const) {
    const s = new Scene3D({
      background: "#000000", animate: false,
      camera: { position: [0, 3, 0.001], target: [0, 0, 0], fov: 50 },
      light: { direction: [0, 1, 0], intensity: 1, ambientIntensity: 0 },
    });
    s.add(node);
    const c = s.capture(64, 64);
    check(`${name} winding faces outward`, pixel(c, 32, 32)[0] > 200, pixel(c, 32, 32));
    s.dispose();
  }

  // Depth: a near red box must hide a far white one directly behind it.
  {
    const s = new Scene3D({
      background: "#000000", animate: false,
      camera: { position: [0, 0, 6], target: [0, 0, 0], fov: 50 },
      light: { direction: [0, 0, 1], ambientIntensity: 0 },
    });
    s.add(box({ size: 2, position: [0, 0, -3], color: "#ffffff" }));
    s.add(box({ size: 2, position: [0, 0, 0], color: "#ff0000" }));
    const c = s.capture(64, 64);
    const [r, g, b] = pixel(c, 32, 32);
    // Red-dominant rather than pure red: a face pointing straight at both the
    // light and the camera picks up the full specular term, which is white and
    // lifts every channel by about a quarter.
    check("the near object occludes the far one", r > 200 && r > g * 2 && r > b * 2, [r, g, b]);
    s.dispose();
  }

  // Node colour and visibility.
  {
    const s = new Scene3D({
      background: "#000000", animate: false,
      camera: { position: [0, 0, 4], target: [0, 0, 0], fov: 50 },
      light: { direction: [0, 0, 1], ambientIntensity: 0 },
    });
    const b = s.add(box({ size: 2, color: "#00ff00" }));
    check("node colour reaches the shader", pixel(s.capture(64, 64), 32, 32)[1] > 200);
    b.visible = false;
    check("visible=false removes it", pixel(s.capture(64, 64), 32, 32).join(",") === "0,0,0");
    b.visible = true;
    b.setColor("#0000ff");
    check("setColor takes effect", pixel(s.capture(64, 64), 32, 32)[2] > 200);
    s.dispose();
  }

  // The scene is a View: it lays out in a stack and drives its own frames.
  {
    const s = new Scene3D({ height: 200, animate: false });
    s.add(box({ color: "#aa091b" }));
    const stack = new VStack({ spacing: 8, padding: 12 }, [new HStack({}, []), s]);
    const win = new Window({ title: "metal", size: { width: 420, height: 320 }, content: stack, show: true });
    for (let i = 0; i < 25; i++) pumpOnce(0.004);
    win.native.contentView().layoutSubtreeIfNeeded();

    check("Scene3D lays out like any other view",
      s.frame.width > 300 && Math.abs(s.frame.height - 200) < 1,
      `${s.frame.width}x${s.frame.height}`);

    s.draw(); // on-screen path: nextDrawable, present, commit
    const size = s.layer.drawableSize();
    check("the layer sized itself to the backing store", size.width >= s.frame.width, JSON.stringify(size));

    let frames = 0;
    s.onFrame(() => frames++);
    s.start();
    for (let i = 0; i < 40; i++) pumpOnce(0.006);
    check("the run loop drives frames", frames > 3, frames);
    // Let the display report in, then ask when the frames reached it.
    for (let i = 0; i < 40 && s.stats.present.samples === 0; i++) pumpOnce(0.006);
    const present = s.stats.present;
    check("presented frames report when they reached the screen", present.samples > 0, JSON.stringify(present));
    check("…a plausible latency", present.latencyMs > 0 && present.latencyMs < DROP_AFTER_MS,
      present.latencyMs);
    // The animated loop only draws when the drawable thread has one free, so it never
    // waits in nextDrawable on the main thread.
    check("animated frames are drawn into drawables that were already free",
      s.stats.ready > 0 && s.stats.waitMs === 0, JSON.stringify({ ready: s.stats.ready, waitMs: s.stats.waitMs }));

    // A resize makes the drawable the thread holds the wrong size. It has to be let go at
    // once: held until the wrapper is collected, it starves the layer and the next frame
    // waits a whole second for a drawable.
    win.native.setContentSize_({ width: 520, height: 360 });
    const resizedAt = performance.now();
    const before = frames;
    for (let i = 0; i < 30; i++) pumpOnce(0.004);
    const took = performance.now() - resizedAt;
    check("frames carry on straight after a resize", frames > before + 3 && took < 800,
      `${frames - before} frames in ${took.toFixed(0)} ms`);
    s.stop();
    const stopped = frames;
    for (let i = 0; i < 20; i++) pumpOnce(0.004);
    check("stop() stops them", frames === stopped, `${stopped} -> ${frames}`);

    s.dispose();
    win.close();
  }
}

// ---------------------------------------------------------------------------
// A material that reads no normal is spared the normal matrix, and still draws
// ---------------------------------------------------------------------------
{
  check("materials read normals unless they say not", material({}).normals === true);
  check("emissive() says it does not", emissive().normals === false);
  if (gpuAvailable()) {
    const flat = material({ normals: false, fragment: "return float4(in.color.rgb, 1.0);" });
    const s = new Scene3D({ background: "#000000", animate: false });
    s.camera.position = { x: 0, y: 0, z: 5 };
    s.camera.target = { x: 0, y: 0, z: 0 };
    // Non-uniformly scaled: the case that would otherwise pay for an inverse-transpose.
    s.add(box({ size: [3, 1, 0.1], color: "#00ff00", material: flat }));
    const px = s.capture(64, 64).pixels;
    const at = (32 * 64 + 32) * 4;
    check("a normal-free material still draws its colour", px[at + 1]! > 200, [...px.slice(at, at + 4)]);
    s.dispose();
  }
}

// ---------------------------------------------------------------------------
// When frames reach the screen: the tracker, against fake drawables
// ---------------------------------------------------------------------------
{
  /** A drawable the test controls: shown at `at` seconds, or never. */
  const fake = () => {
    const d = { at: 0, retains: 0, releases: 0,
      presentedTime: () => d.at, retain: () => d.retains++, release: () => d.releases++ };
    return d;
  };
  const t = new PresentTracker();
  const a = fake(), b = fake(), c = fake();
  t.track(a, 1_000);
  t.track(b, 1_008);
  t.track(c, 1_016);
  check("a tracked drawable is retained", a.retains === 1 && t.pending === 3);
  t.poll(1_010);
  check("nothing reported: nothing measured", t.stats.samples === 0 && t.pending === 3);

  a.at = 1.030; // shown 30 ms after it was drawn
  b.at = 1.040; // 32 ms, one 10 ms refresh later
  t.poll(1_041);
  const s = t.stats;
  check("reported frames are measured and let go",
    s.samples === 2 && a.releases === 1 && b.releases === 1 && t.pending === 1, JSON.stringify(s));
  check("latency is shown minus drawn", Math.abs(s.latencyMs - 30) < 1e-6 && Math.abs(s.latencyP95Ms - 30) < 1e-6,
    JSON.stringify(s));
  check("refresh is the gap between presentations", Math.abs(s.refreshMs - 10) < 1e-6, s.refreshMs);

  t.poll(1_016 + DROP_AFTER_MS + 1);
  check("a frame never shown is dropped, and let go", t.stats.dropped === 1 && c.releases === 1 && t.pending === 0);

  const d = fake();
  t.track(d, 2_000);
  t.dispose();
  check("dispose releases what is still held", d.releases === 1 && t.pending === 0);

  check("before enough frames, the latency is assumed",
    screenLatencyMs({ samples: MIN_PRESENT_SAMPLES - 1, latencyMs: 12 }) === ASSUMED_LATENCY_MS);
  check("after, it is measured", screenLatencyMs({ samples: MIN_PRESENT_SAMPLES, latencyMs: 12 }) === 12);
}

console.log(failures === 0 ? "\nALL METAL TESTS PASSED" : `\n${failures} METAL FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
