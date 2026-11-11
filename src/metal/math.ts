// Vectors and 4x4 matrices, laid out the way Metal wants them.
//
// Column-major, because that is what MSL's `float4x4` is: element (row r,
// column c) lives at index c * 4 + r, and a transform is applied as
// `matrix * vector`. Getting this backwards produces a scene that is subtly
// sheared rather than obviously broken, so every function here is written and
// tested against that one convention.

export type Vec3 = { x: number; y: number; z: number };

/** A 4x4 matrix as 16 floats, column-major. */
export type Mat4 = Float32Array;

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function v3add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function v3sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function v3scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function v3cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
export function v3length(a: Vec3): number {
  return Math.sqrt(v3dot(a, a));
}
export function v3normalize(a: Vec3): Vec3 {
  const l = v3length(a);
  return l > 1e-8 ? v3scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
}

/** Accepts a Vec3 or the [x, y, z] shorthand the public API allows. */
export function toVec3(v: Vec3 | readonly [number, number, number] | number): Vec3 {
  if (typeof v === "number") return { x: v, y: v, z: v };
  return Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : (v as Vec3);
}

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

export function mat4(): Mat4 {
  return identity(new Float32Array(16));
}

export function identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a * b. Applied to a vector, b happens first. */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  // Written to a temporary so `multiply(m, n, m)` is safe.
  const r = out === a || out === b ? new Float32Array(16) : out;
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 4; i++) {
      r[c * 4 + i] =
        a[i]! * b[c * 4]! +
        a[4 + i]! * b[c * 4 + 1]! +
        a[8 + i]! * b[c * 4 + 2]! +
        a[12 + i]! * b[c * 4 + 3]!;
    }
  }
  if (r !== out) out.set(r);
  return out;
}

export function translation(v: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  identity(out);
  out[12] = v.x;
  out[13] = v.y;
  out[14] = v.z;
  return out;
}

export function scaling(v: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  identity(out);
  out[0] = v.x;
  out[5] = v.y;
  out[10] = v.z;
  return out;
}

export function rotationX(rad: number, out: Mat4 = new Float32Array(16)): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad);
  identity(out);
  out[5] = c;
  out[6] = s;
  out[9] = -s;
  out[10] = c;
  return out;
}

export function rotationY(rad: number, out: Mat4 = new Float32Array(16)): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad);
  identity(out);
  out[0] = c;
  out[2] = -s;
  out[8] = s;
  out[10] = c;
  return out;
}

export function rotationZ(rad: number, out: Mat4 = new Float32Array(16)): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad);
  identity(out);
  out[0] = c;
  out[1] = s;
  out[4] = -s;
  out[5] = c;
  return out;
}

/**
 * Scale, then rotate Z-X-Y, then translate — the order that makes
 * `node.rotation.y` read as spinning in place rather than orbiting the origin.
 */
export function compose(position: Vec3, rotation: Vec3, scale: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  // Written out rather than built from rotationZ/X/Y and multiplied, because
  // this runs once per node per frame and the assembled version allocated four
  // intermediate matrices to do 256 multiply-adds. Measured, 0.27us against
  // 0.03us. The order is still Ry * Rx * Rz, then scale, then translation —
  // change that here and aimAt has to change with it.
  const sa = Math.sin(rotation.x), ca = Math.cos(rotation.x);
  const sb = Math.sin(rotation.y), cb = Math.cos(rotation.y);
  const sc = Math.sin(rotation.z), cc = Math.cos(rotation.z);
  const { x: sx, y: sy, z: sz } = scale;

  // Column-major: out[0..2] is the first column, scaled by sx.
  out[0] = (cb * cc + sb * sa * sc) * sx;
  out[1] = ca * sc * sx;
  out[2] = (cb * sa * sc - sb * cc) * sx;
  out[3] = 0;

  out[4] = (sb * sa * cc - cb * sc) * sy;
  out[5] = ca * cc * sy;
  out[6] = (sb * sc + cb * sa * cc) * sy;
  out[7] = 0;

  out[8] = sb * ca * sz;
  out[9] = -sa * sz;
  out[10] = cb * ca * sz;
  out[11] = 0;

  out[12] = position.x;
  out[13] = position.y;
  out[14] = position.z;
  out[15] = 1;
  return out;
}

/**
 * A right-handed perspective projection onto Metal's clip space, whose depth
 * range is 0 to 1 rather than OpenGL's -1 to 1. Using a GL projection here puts
 * half the scene behind the near plane.
 */
export function perspective(
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

/** How much of each edge of a view is covered — by a toolbar, a sidebar — in any one unit. */
export interface Insets4 {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/**
 * A perspective projection fitted to the part of a view that is **not covered** — the
 * rectangle left inside `insets` — while still filling the whole view.
 *
 * Content that runs under glass (a sidebar, an inspector, a toolbar) would otherwise frame
 * itself on the middle of the whole view, part of which nobody can see. This is the
 * projection a camera would have if the visible rectangle were the entire viewport, with the
 * picture carried on out under the covered edges: `fovYRadians` spans the visible height,
 * and the visible centre is where the camera looks. With no insets it is exactly
 * {@link perspective}.
 *
 * Only ratios matter, so `width`, `height` and `insets` may be points or pixels as long as
 * they agree. Metal's 0–1 depth, right-handed, as {@link perspective}.
 */
export function insetPerspective(
  fovYRadians: number,
  width: number,
  height: number,
  insets: Insets4,
  near: number,
  far: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const W = Math.max(1, width);
  const H = Math.max(1, height);
  const visibleH = Math.max(1, H - insets.top - insets.bottom);
  const f = 1 / Math.tan(fovYRadians / 2);
  out.fill(0);
  // The visible rectangle's own projection (aspect = its width over its height), scaled by
  // its share of the view and moved to its centre in clip space.
  out[0] = (f * visibleH) / W;
  out[5] = (f * visibleH) / H;
  out[8] = -(insets.left - insets.right) / W;
  out[9] = -(insets.bottom - insets.top) / H;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

/** A right-handed view matrix: the camera sits at `eye` looking at `target`. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  const z = v3normalize(v3sub(eye, target)); // backwards
  const x = v3normalize(v3cross(up, z));     // right
  const y = v3cross(z, x);                   // true up
  out[0] = x.x; out[1] = y.x; out[2] = z.x; out[3] = 0;
  out[4] = x.y; out[5] = y.y; out[6] = z.y; out[7] = 0;
  out[8] = x.z; out[9] = y.z; out[10] = z.z; out[11] = 0;
  out[12] = -v3dot(x, eye);
  out[13] = -v3dot(y, eye);
  out[14] = -v3dot(z, eye);
  out[15] = 1;
  return out;
}

export function transpose(a: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  const r = out === a ? new Float32Array(16) : out;
  for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) r[c * 4 + i] = a[i * 4 + c]!;
  if (r !== out) out.set(r);
  return out;
}

/** Full 4x4 inverse. Returns identity for a singular matrix rather than NaNs. */
export function invert(m: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  const a = m;
  const b00 = a[0]! * a[5]! - a[1]! * a[4]!;
  const b01 = a[0]! * a[6]! - a[2]! * a[4]!;
  const b02 = a[0]! * a[7]! - a[3]! * a[4]!;
  const b03 = a[1]! * a[6]! - a[2]! * a[5]!;
  const b04 = a[1]! * a[7]! - a[3]! * a[5]!;
  const b05 = a[2]! * a[7]! - a[3]! * a[6]!;
  const b06 = a[8]! * a[13]! - a[9]! * a[12]!;
  const b07 = a[8]! * a[14]! - a[10]! * a[12]!;
  const b08 = a[8]! * a[15]! - a[11]! * a[12]!;
  const b09 = a[9]! * a[14]! - a[10]! * a[13]!;
  const b10 = a[9]! * a[15]! - a[11]! * a[13]!;
  const b11 = a[10]! * a[15]! - a[11]! * a[14]!;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return identity(out);
  const d = 1 / det;

  out[0] = (a[5]! * b11 - a[6]! * b10 + a[7]! * b09) * d;
  out[1] = (a[2]! * b10 - a[1]! * b11 - a[3]! * b09) * d;
  out[2] = (a[13]! * b05 - a[14]! * b04 + a[15]! * b03) * d;
  out[3] = (a[10]! * b04 - a[9]! * b05 - a[11]! * b03) * d;
  out[4] = (a[6]! * b08 - a[4]! * b11 - a[7]! * b07) * d;
  out[5] = (a[0]! * b11 - a[2]! * b08 + a[3]! * b07) * d;
  out[6] = (a[14]! * b02 - a[12]! * b05 - a[15]! * b01) * d;
  out[7] = (a[8]! * b05 - a[10]! * b02 + a[11]! * b01) * d;
  out[8] = (a[4]! * b10 - a[5]! * b08 + a[7]! * b06) * d;
  out[9] = (a[1]! * b08 - a[0]! * b10 - a[3]! * b06) * d;
  out[10] = (a[12]! * b04 - a[13]! * b02 + a[15]! * b00) * d;
  out[11] = (a[9]! * b02 - a[8]! * b04 - a[11]! * b00) * d;
  out[12] = (a[5]! * b07 - a[4]! * b09 - a[6]! * b06) * d;
  out[13] = (a[0]! * b09 - a[1]! * b07 + a[2]! * b06) * d;
  out[14] = (a[13]! * b01 - a[12]! * b03 - a[14]! * b00) * d;
  out[15] = (a[8]! * b03 - a[9]! * b01 + a[10]! * b00) * d;
  return out;
}

/**
 * The matrix that transforms normals: the inverse transpose of the model
 * matrix. Under non-uniform scale the model matrix alone bends normals off the
 * surface and the lighting goes wrong, which is the only reason this exists.
 */
export function normalMatrix(model: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  return transpose(invert(model, out), out);
}

export const radians = (deg: number): number => (deg * Math.PI) / 180;
export const degrees = (rad: number): number => (rad * 180) / Math.PI;
