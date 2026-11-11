// Layer 1 — the raw FFI boundary.
//
// Everything above this file speaks in JS values; everything below speaks in
// packed byte buffers. This module owns dlopen, the signature-layout cache and
// the argument-buffer pool, and nothing else.
//
// Pointer representation: **Objective-C object pointers are BigInt**, never
// number. Apple encodes short NSStrings, small NSNumbers, NSDates and friends
// directly in the pointer as "tagged pointers", which sets the high bits and
// puts the value far beyond 2^53. Our own buffers (argbuf, layout scratch) are
// ordinary heap addresses and stay plain numbers.

import { dlopen, FFIType, JSCallback, ptr, suffix, toArrayBuffer, CString } from "bun:ffi";
import type { Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** An Objective-C pointer. Always a BigInt — see the note above. */
export type Ptr = bigint;
export const NIL: Ptr = 0n;

/**
 * bun:ffi types a raw address as an opaque brand, but at runtime it is a plain
 * number. This is the one place that conversion is spelled out.
 *
 * The brand itself, not a parameter type borrowed from a bun:ffi function:
 * `toArrayBuffer` now also takes `number | bigint`, and a `ptr` argument does
 * not take a bare `number`, so the borrowed type stopped fitting the calls.
 */
export type BunPointer = Pointer;
export function asPointer(addr: number | bigint): BunPointer {
  return (typeof addr === "bigint" ? Number(addr) : addr) as unknown as BunPointer;
}

// ---------------------------------------------------------------------------
// Locate the dylib
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

function findLib(): string {
  const candidates = [
    process.env.OBJCBRIDGE_DYLIB,
    resolve(here, "../build/libobjcbridge.dylib"),
    resolve(here, "../../build/libobjcbridge.dylib"),
    // Inside a packaged .app: Contents/Resources/app/src -> Contents/Frameworks
    resolve(here, "../../Frameworks/libobjcbridge.dylib"),
    resolve(process.cwd(), "build/libobjcbridge.dylib"),
    `libobjcbridge.${suffix}`,
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `libobjcbridge.dylib not found. Run ./native/build.sh first.\nLooked in:\n  ${candidates.join("\n  ")}`,
  );
}

// The dispatcher is written to the arm64 ABI. On any other architecture the
// struct-return convention differs, and the failure mode would be silently
// wrong geometry rather than a crash — so refuse up front.
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    `BunKit requires macOS on Apple silicon; this is ${process.platform}/${process.arch}.`,
  );
}

export const LIB_PATH = findLib();

const OBJ = FFIType.u64; // an Obj-C pointer (may be tagged)
const BUF = FFIType.ptr; // one of our own buffers
const I32 = FFIType.i32;
const U32 = FFIType.u32;
const I64 = FFIType.i64;
const F64 = FFIType.f64;
const V = FFIType.void;
const CSTR = FFIType.cstring;

export const lib = dlopen(LIB_PATH, {
  br_version: { args: [], returns: CSTR },

  br_class: { args: [CSTR], returns: OBJ },
  br_metaclass: { args: [CSTR], returns: OBJ },
  br_selector: { args: [CSTR], returns: OBJ },
  br_selector_name: { args: [OBJ], returns: CSTR },
  br_method_signature: { args: [OBJ, OBJ, I32], returns: CSTR },
  br_protocol_method_signature: { args: [CSTR, OBJ, I32, I32], returns: CSTR },
  br_object_class_name: { args: [OBJ], returns: CSTR },
  br_object_class: { args: [OBJ], returns: OBJ },
  br_responds: { args: [OBJ, OBJ], returns: I32 },
  br_class_responds: { args: [OBJ, OBJ, I32], returns: I32 },
  br_is_kind_of: { args: [OBJ, OBJ], returns: I32 },
  br_class_super_name: { args: [OBJ], returns: CSTR },
  br_copy_method_list: { args: [OBJ, I32, BUF, I32], returns: I32 },
  br_copy_class_list: { args: [BUF, I32], returns: I32 },
  br_copy_protocol_method_list: { args: [CSTR, BUF, I32], returns: I32 },

  br_signature_layout: { args: [CSTR, BUF, I32], returns: I32 },
  br_type_layout: { args: [CSTR, BUF, I32], returns: I32 },

  br_call_function: { args: [OBJ, CSTR, BUF, BUF, BUF], returns: I32 },
  br_msgsend: { args: [OBJ, OBJ, CSTR, BUF, BUF, BUF], returns: I32 },
  br_msgsend_super: { args: [OBJ, OBJ, OBJ, CSTR, BUF, BUF, BUF], returns: I32 },

  br_class_create: { args: [CSTR, CSTR], returns: OBJ },
  br_class_add_method: { args: [OBJ, OBJ, CSTR, BUF, U32, I32], returns: I32 },
  br_class_add_protocol: { args: [OBJ, CSTR], returns: I32 },
  br_class_register: { args: [OBJ], returns: V },
  br_object_set_token: { args: [OBJ, U32], returns: V },
  br_object_get_token: { args: [OBJ], returns: U32 },

  br_block_create: { args: [CSTR, BUF, U32], returns: OBJ },
  br_block_release: { args: [OBJ], returns: V },

  br_retain: { args: [OBJ], returns: OBJ },
  br_release: { args: [OBJ], returns: V },
  br_autorelease: { args: [OBJ], returns: V },
  br_retain_count: { args: [OBJ], returns: I64 },
  br_autorelease_pool_push: { args: [], returns: V },
  br_autorelease_pool_pop: { args: [], returns: V },
  br_autorelease_pool_recycle: { args: [], returns: I32 },
  br_autorelease_pool_depth: { args: [], returns: I32 },
  br_free: { args: [BUF], returns: V },

  br_nsstring: { args: [BUF, I32], returns: OBJ },
  br_nsstring_utf8: { args: [OBJ], returns: CSTR },
  br_nsstring_len: { args: [OBJ], returns: I32 },

  br_dlsym: { args: [CSTR], returns: OBJ },

  br_app_init: { args: [I32], returns: V },
  br_set_terminate_after_last_window: { args: [I32], returns: V },
  br_set_stop_callback: { args: [BUF], returns: V },
  br_pump: { args: [F64], returns: I32 },
  br_stop: { args: [], returns: V },
  br_should_stop: { args: [], returns: I32 },
  br_post_empty_event: { args: [], returns: V },
  br_now: { args: [], returns: F64 },

  br_drawables_create: { args: [OBJ], returns: OBJ },
  br_drawables_arm: { args: [OBJ, I32], returns: V },
  br_drawables_ready: { args: [OBJ], returns: I32 },
  br_drawables_take: { args: [OBJ], returns: OBJ },
  br_drawables_destroy: { args: [OBJ], returns: V },

  br_library_compile: { args: [OBJ, BUF], returns: OBJ },
  br_render_pipeline_compile: { args: [OBJ, OBJ, FFIType.u64], returns: OBJ },
  br_compute_pipeline_compile: { args: [OBJ, OBJ, FFIType.u64], returns: OBJ },
  br_compile_poll: { args: [OBJ], returns: I32 },
  br_compile_take: { args: [OBJ], returns: OBJ },
  br_compile_take_reflection: { args: [OBJ], returns: OBJ },
  br_compile_error: { args: [OBJ], returns: OBJ },
  br_compile_free: { args: [OBJ], returns: V },
  br_bundle_path: { args: [], returns: CSTR },
}).symbols;

// ---------------------------------------------------------------------------
// C strings
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** NUL-terminated UTF-8 buffer suitable for a `const char*` argument. */
export function cstr(s: string): Uint8Array {
  const bytes = encoder.encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

const cstrCache = new Map<string, Uint8Array>();
/** Memoised cstr for hot, repeated strings (selectors, class names, encodings). */
export function cstrCached(s: string): Uint8Array {
  let b = cstrCache.get(s);
  if (b === undefined) {
    b = cstr(s);
    if (cstrCache.size < 8192) cstrCache.set(s, b);
  }
  return b;
}

/** Read a NUL-terminated C string from a native address. */
export function readCString(addr: number | bigint): string {
  const n = typeof addr === "bigint" ? Number(addr) : addr;
  return n ? new CString(asPointer(n)).toString() : "";
}

// ---------------------------------------------------------------------------
// Type kinds — must mirror the enum in bridge.h
// ---------------------------------------------------------------------------

export const K = {
  VOID: 0,
  SINT8: 1,
  UINT8: 2,
  SINT16: 3,
  UINT16: 4,
  SINT32: 5,
  UINT32: 6,
  SINT64: 7,
  UINT64: 8,
  FLOAT: 9,
  DOUBLE: 10,
  BOOL: 11,
  OBJECT: 12,
  CLASS: 13,
  SEL: 14,
  CHARPTR: 15,
  POINTER: 16,
  STRUCT: 17,
  UNION: 18,
  ARRAY: 19,
  BLOCK: 20,
  UNKNOWN: 21,
} as const;

export const KIND_NAMES: string[] = [
  "void", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64",
  "uint64", "float", "double", "bool", "object", "Class", "SEL", "char*",
  "pointer", "struct", "union", "array", "block", "unknown",
];

export const BR_OK = 0;

// ---------------------------------------------------------------------------
// Signature layouts
// ---------------------------------------------------------------------------

export interface ArgInfo {
  kind: number;
  size: number;
  align: number;
  offset: number;
}

export interface SigLayout {
  encoding: string;
  nargs: number;
  argbufSize: number;
  retbufSize: number;
  ret: { kind: number; size: number; align: number };
  args: ArgInfo[];
  /** Number of user-supplied arguments (total minus self and _cmd). */
  userArgs: number;
}

const layoutScratch = new Int32Array(1024);
const layoutScratchPtr = ptr(layoutScratch);
const sigCache = new Map<string, SigLayout>();

export function sigLayout(encoding: string): SigLayout {
  const hit = sigCache.get(encoding);
  if (hit) return hit;
  const n = lib.br_signature_layout(cstrCached(encoding), layoutScratchPtr, layoutScratch.length);
  if (n < 0) throw new Error(`cannot parse Obj-C type encoding: ${JSON.stringify(encoding)}`);
  const nargs = layoutScratch[0]!;
  const out: SigLayout = {
    encoding,
    nargs,
    argbufSize: layoutScratch[1]!,
    retbufSize: layoutScratch[2]!,
    ret: { kind: layoutScratch[3]!, size: layoutScratch[4]!, align: layoutScratch[5]! },
    args: new Array(nargs),
    userArgs: Math.max(0, nargs - 2),
  };
  for (let i = 0; i < nargs; i++) {
    const b = 6 + i * 4;
    out.args[i] = {
      kind: layoutScratch[b]!,
      size: layoutScratch[b + 1]!,
      align: layoutScratch[b + 2]!,
      offset: layoutScratch[b + 3]!,
    };
  }
  sigCache.set(encoding, out);
  return out;
}

/** Layout of a single bare type encoding, e.g. "{CGRect={CGPoint=dd}{CGSize=dd}}". */
export function typeLayout(type: string): { kind: number; size: number; align: number } {
  const n = lib.br_type_layout(cstrCached(type), layoutScratchPtr, layoutScratch.length);
  if (n < 0) throw new Error(`cannot parse type: ${JSON.stringify(type)}`);
  return { kind: layoutScratch[0]!, size: layoutScratch[1]!, align: layoutScratch[2]! };
}

// ---------------------------------------------------------------------------
// Buffer pool
//
// Calls nest (msgSend -> AppKit -> delegate -> msgSend), so buffers come from a
// stack that grows on demand; a slot is never handed out twice while live.
// ---------------------------------------------------------------------------

export interface Slot {
  argBytes: Uint8Array;
  argView: DataView;
  argPtr: number;
  retView: DataView;
  retPtr: number;
  errBytes: BigUint64Array;
  errPtr: number;
  capArg: number;
  capRet: number;
}

const SLOT_INITIAL_ARG = 256;
const SLOT_INITIAL_RET = 128;
const slots: Slot[] = [];
let depth = 0;

function newSlot(argCap: number, retCap: number): Slot {
  const argBytes = new Uint8Array(argCap);
  const retBytes = new Uint8Array(retCap);
  const errBytes = new BigUint64Array(1);
  return {
    argBytes,
    argView: new DataView(argBytes.buffer),
    argPtr: ptr(argBytes),
    retView: new DataView(retBytes.buffer),
    retPtr: ptr(retBytes),
    errBytes,
    errPtr: ptr(errBytes),
    capArg: argCap,
    capRet: retCap,
  };
}

export function acquire(argSize: number, retSize: number): Slot {
  let s = slots[depth];
  if (s === undefined || s.capArg < argSize || s.capRet < retSize) {
    s = newSlot(
      Math.max(SLOT_INITIAL_ARG, argSize, s?.capArg ?? 0),
      Math.max(SLOT_INITIAL_RET, retSize, s?.capRet ?? 0),
    );
    slots[depth] = s;
  }
  depth++;
  return s;
}

export function release(): void {
  depth--;
}

export function callDepth(): number {
  return depth;
}

/** Consume the strdup'd error message the shim left behind, if any. */
export function readErr(slot: Slot): string | null {
  const p = slot.errBytes[0]!;
  if (p === 0n) return null;
  const addr = Number(p);
  const msg = new CString(asPointer(addr)).toString();
  lib.br_free(asPointer(addr));
  slot.errBytes[0] = 0n;
  return msg;
}

// ---------------------------------------------------------------------------
// Selectors & classes (memoised)
// ---------------------------------------------------------------------------

const selCache = new Map<string, Ptr>();
export function sel(name: string): Ptr {
  let s = selCache.get(name);
  if (s === undefined) {
    s = lib.br_selector(cstrCached(name)) as bigint;
    selCache.set(name, s);
  }
  return s;
}

const classCache = new Map<string, Ptr>();
export function classFor(name: string): Ptr {
  let c = classCache.get(name);
  if (c === undefined) {
    c = lib.br_class(cstrCached(name)) as bigint;
    classCache.set(name, c);
  }
  return c;
}

/** Method type encoding, or null if the class does not implement the selector. */
export function methodSignature(cls: Ptr, selector: Ptr, instance: boolean): string | null {
  const s = lib.br_method_signature(cls, selector, instance ? 1 : 0);
  return s === null || s === undefined ? null : String(s);
}

export function protocolMethodSignature(
  proto: string,
  selector: Ptr,
  required: boolean,
  instance = true,
): string | null {
  const s = lib.br_protocol_method_signature(
    cstrCached(proto),
    selector,
    required ? 1 : 0,
    instance ? 1 : 0,
  );
  return s === null || s === undefined ? null : String(s);
}

export { ptr, toArrayBuffer, JSCallback, FFIType, CString };
