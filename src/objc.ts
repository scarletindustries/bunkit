// Layer 2 — the Objective-C object model in JavaScript.
//
//   objc.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(...)
//
// Nothing here knows about any particular AppKit class: method lookup, argument
// marshalling and memory ownership are all derived from the runtime.

import {
  lib,
  cstr,
  cstrCached,
  readCString,
  sel as selFor,
  classFor,
  methodSignature,
  protocolMethodSignature,
  sigLayout,
  acquire,
  release as releaseSlot,
  readErr,
  K,
  KIND_NAMES,
  BR_OK,
  NIL,
  ptr,
  toArrayBuffer,
  asPointer,
  JSCallback,
  FFIType,
  type Ptr,
  type SigLayout,
  type ArgInfo,
} from "./bridge.ts";
import { structDef, STRUCTS } from "./structs.ts";

const le = true;

// ---------------------------------------------------------------------------
// Encoding tokenizer (JS side)
//
// The shim tells us sizes and offsets; we still need the *text* of each type so
// we can tell a CGRect from an NSRange and an id from a block.
// ---------------------------------------------------------------------------

const QUALIFIERS = "rnNoORVA+|";

function isDigit(c: string | undefined) {
  return c !== undefined && c >= "0" && c <= "9";
}

function nextType(s: string, i: number): [string, number] {
  while (i < s.length && QUALIFIERS.includes(s[i]!)) i++;
  const start = i;
  const c = s[i];
  if (c === undefined) return ["", i];
  if (c === "@" && s[i + 1] === "?") return [s.slice(start, i + 2), i + 2];
  if (c === "@" && s[i + 1] === '"') {
    i += 2;
    while (i < s.length && s[i] !== '"') i++;
    return [s.slice(start, i + 1), i + 1];
  }
  if (c === "^") {
    const [, j] = nextType(s, i + 1);
    return [s.slice(start, j), j];
  }
  if (c === "b") {
    i++;
    while (isDigit(s[i])) i++;
    return [s.slice(start, i), i];
  }
  if (c === "[" || c === "{" || c === "(") {
    const close = c === "[" ? "]" : c === "{" ? "}" : ")";
    let depth = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === c) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    return [s.slice(start, i), i];
  }
  return [c, i + 1];
}

export interface SplitEncoding {
  ret: string;
  args: string[];
}

const splitCache = new Map<string, SplitEncoding>();

export function splitEncoding(enc: string): SplitEncoding {
  const hit = splitCache.get(enc);
  if (hit) return hit;
  let i = 0;
  const [ret, j] = nextType(enc, 0);
  i = j;
  while (isDigit(enc[i])) i++;
  const args: string[] = [];
  while (i < enc.length) {
    const [t, k] = nextType(enc, i);
    if (!t) break;
    i = k;
    while (isDigit(enc[i])) i++;
    args.push(t);
  }
  const out = { ret, args };
  splitCache.set(enc, out);
  return out;
}

// ---------------------------------------------------------------------------
// Ownership: method families
// ---------------------------------------------------------------------------

const FAMILIES = ["alloc", "new", "copy", "mutableCopy", "init"] as const;

function methodFamily(sel: string): string | null {
  let i = 0;
  while (sel[i] === "_") i++;
  for (const f of FAMILIES) {
    if (sel.startsWith(f, i)) {
      const next = sel[i + f.length];
      // "initialize" is not the init family; "newer" is not the new family.
      if (next === undefined || !(next >= "a" && next <= "z")) return f;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Object wrappers & identity
// ---------------------------------------------------------------------------

const liveObjects = new Map<Ptr, WeakRef<ObjCObject>>();

const finalizers = new FinalizationRegistry<{ p: Ptr; ref: WeakRef<ObjCObject> }>(
  ({ p, ref }) => {
    if (liveObjects.get(p) === ref) liveObjects.delete(p);
    lib.br_release(p);
  },
);

let statsWrapped = 0;
let statsCalls = 0;
let statsReleased = 0;

// Names JS runtimes probe for on arbitrary objects. If these fell through to
// selector dispatch, `await obj` and `JSON.stringify(obj)` would explode.
const RESERVED = new Set(["then", "toJSON", "inspect", "nodeType", "$$typeof", "_bunTag"]);

export class ObjCObject {
  readonly ptr: Ptr;
  #disowned = false;
  #key: { p: Ptr; ref: WeakRef<ObjCObject> } | null = null;

  constructor(p: Ptr) {
    this.ptr = p;
    statsWrapped++;
  }

  /** @internal — called by wrap() once the identity-map entry exists. */
  _track(key: { p: Ptr; ref: WeakRef<ObjCObject> }) {
    this.#key = key;
    finalizers.register(this, key, this);
  }

  #forget() {
    this.#disowned = true;
    finalizers.unregister(this);
    if (this.#key && liveObjects.get(this.#key.p) === this.#key.ref) {
      liveObjects.delete(this.#key.p);
    }
  }

  /**
   * Give up this wrapper's retain *without* releasing — used when `init`
   * returns a different object and takes ownership of the receiver.
   */
  _disown() {
    if (this.#disowned) return;
    this.#forget();
  }

  /** Release now rather than waiting for GC. The wrapper becomes unusable. */
  dispose() {
    if (this.#disowned) return;
    this.#forget();
    statsReleased++;
    lib.br_release(this.ptr);
  }

  get className(): string {
    return String(lib.br_object_class_name(this.ptr));
  }

  get objcClass(): ObjCClass {
    return classByPtr(lib.br_object_class(this.ptr) as bigint);
  }

  isKindOf(cls: ObjCClass | string): boolean {
    const c = typeof cls === "string" ? classFor(cls) : cls.ptr;
    return lib.br_is_kind_of(this.ptr, c) !== 0;
  }

  respondsTo(sel: string): boolean {
    return lib.br_responds(this.ptr, selFor(sel)) !== 0;
  }

  retainCount(): number {
    return Number(lib.br_retain_count(this.ptr));
  }

  /** Invoke by raw selector, e.g. obj.send("setFrame:display:", rect, true). */
  send(selector: string, ...args: any[]): any {
    return invoke(this.ptr, lib.br_object_class(this.ptr) as bigint, true, selector, args, this);
  }

  /** Invoke the superclass implementation. */
  sendSuper(superclass: ObjCClass | string, selector: string, ...args: any[]): any {
    const sc = typeof superclass === "string" ? classFor(superclass) : superclass.ptr;
    return invokeSuper(this.ptr, sc, selector, args);
  }

  toString(): string {
    if (this.ptr === NIL) return "nil";
    if (isKind(this.ptr, "NSString")) return nsstringToJS(this.ptr) ?? "";
    try {
      const d = this.send("description");
      return d instanceof ObjCObject ? (nsstringToJS(d.ptr) ?? this.className) : String(d);
    } catch {
      return `<${this.className} 0x${this.ptr.toString(16)}>`;
    }
  }

  [Symbol.toPrimitive](hint: string) {
    if (hint === "number") return Number(this.ptr);
    return this.toString();
  }

  /** Deep-convert common Foundation containers to plain JS values. */
  js(): any {
    return toJS(this);
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `[${this.className} ${this.toString()}]`;
  }
}

export class ObjCClass extends ObjCObject {
  readonly name: string;
  constructor(p: Ptr, name: string) {
    super(p);
    this.name = name;
  }
  alloc(): any {
    return invoke(this.ptr, this.ptr, false, "alloc", [], this);
  }
  new(): any {
    return invoke(this.ptr, this.ptr, false, "new", [], this);
  }
  send(selector: string, ...args: any[]): any {
    return invoke(this.ptr, this.ptr, false, selector, args, this);
  }
  toString() {
    return this.name;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `[Class ${this.name}]`;
  }
}

// --- proxies ---------------------------------------------------------------

const objectProxyHandler: ProxyHandler<ObjCObject> = {
  get(target, prop) {
    if (typeof prop !== "string") return Reflect.get(target, prop, target);
    if (RESERVED.has(prop)) return undefined;
    const own = Reflect.get(target, prop, target);
    if (own !== undefined) return typeof own === "function" ? own.bind(target) : own;
    if (prop in target) return Reflect.get(target, prop, target);
    const selector = toSelector(prop);
    const isCls = target instanceof ObjCClass;
    return (...args: any[]) =>
      invoke(
        target.ptr,
        isCls ? target.ptr : (lib.br_object_class(target.ptr) as bigint),
        !isCls,
        selector,
        args,
        target,
      );
  },
  has(target, prop) {
    if (typeof prop !== "string") return Reflect.has(target, prop);
    if (prop in target) return true;
    return lib.br_responds(target.ptr, selFor(toSelector(prop))) !== 0;
  },
};

/** `initWithFrame_options_` -> `initWithFrame:options:`; `$foo` -> `_foo`. */
export function toSelector(name: string): string {
  if (!name.includes("_") && !name.includes("$")) return name;
  return name.replace(/_/g, ":").replace(/\$/g, "_");
}

export function fromSelector(sel: string): string {
  return sel.replace(/_/g, "$").replace(/:/g, "_");
}

// Every wrapper is handed out as a Proxy, but internal code holds the raw
// object (private fields don't survive a proxy `this`). __proxy bridges back.
function proxied<T extends ObjCObject>(o: T): T {
  const p = new Proxy(o, objectProxyHandler as ProxyHandler<T>) as T;
  (o as any).__proxy = p;
  return p;
}

function outward<T extends ObjCObject>(o: T): T {
  return ((o as any).__proxy as T) ?? o;
}

// ---------------------------------------------------------------------------
// wrap / unwrap
// ---------------------------------------------------------------------------

const classProxies = new Map<Ptr, ObjCClass>();

function classByPtr(p: Ptr): ObjCClass {
  if (p === NIL) return null as any;
  let c = classProxies.get(p);
  if (!c) {
    const name = String(lib.br_object_class_name(p));
    c = proxied(new ObjCClass(p, name));
    classProxies.set(p, c);
  }
  return c;
}

/** Look up a class that may not exist on this OS version. Null instead of throwing. */
export function tryClass(name: string): ObjCClass | null {
  return classFor(name) === NIL ? null : getClass(name);
}

export function getClass(name: string): ObjCClass {
  const p = classFor(name);
  if (p === NIL) throw new Error(`Objective-C class not found: ${name}`);
  let c = classProxies.get(p);
  if (!c) {
    c = proxied(new ObjCClass(p, name));
    classProxies.set(p, c);
  }
  return c;
}

/**
 * Wrap a raw pointer.
 *
 * Invariant: every live wrapper holds exactly one retain, released by its
 * finalizer. `plusOne` says the callee already handed us an ownership.
 */
export function wrap(p: Ptr, plusOne = false): any {
  if (p === NIL) return null;
  const existing = liveObjects.get(p)?.deref();
  if (existing) {
    if (plusOne) lib.br_release(p);
    return existing;
  }
  if (!plusOne) lib.br_retain(p);
  const raw = new ObjCObject(p);
  const o = proxied(raw);
  const ref = new WeakRef(o);
  liveObjects.set(p, ref);
  raw._track({ p, ref });
  return o;
}

export function unwrap(v: any): Ptr {
  if (v === null || v === undefined) return NIL;
  if (v instanceof ObjCObject) return v.ptr;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  throw new TypeError(`not an Objective-C object: ${String(v)}`);
}

// ---------------------------------------------------------------------------
// NSString fast paths
// ---------------------------------------------------------------------------

/** Create a +1 NSString from a JS string. Caller owns it. */
export function makeStringRaw(s: string): Ptr {
  const b = cstr(s);
  return lib.br_nsstring(ptr(b), b.length - 1) as bigint;
}

export function nsstringToJS(p: Ptr): string | null {
  if (p === NIL) return null;
  const s = lib.br_nsstring_utf8(p);
  return s === null || s === undefined ? null : String(s);
}

/** A managed NSString wrapper. */
export function nsstring(s: string): ObjCObject {
  return wrap(makeStringRaw(s), true)!;
}

/**
 * Unwrap a Layer 3 wrapper to the Obj-C object underneath.
 *
 * The instanceof check is the whole point. An ObjCObject is a Proxy that
 * answers *every* property with a selector dispatcher, so the obvious
 * `x.native ?? x` hands back a JS function when x is already an ObjCObject —
 * and a function marshalled into an object argument becomes a block, which
 * fails later and far away with "unrecognized selector sent to __NSGlobalBlock__".
 */
export function nativeOf(v: any): any {
  if (v === null || v === undefined) return null;
  if (v instanceof ObjCObject) return v;
  return v.native ?? v;
}

/**
 * Is this an Objective-C object rather than a plain JavaScript one?
 *
 * Ask before reading any property off a value that might be either. An
 * ObjCObject is a proxy that turns *every* unknown property into a method
 * closure, so `maybeNative.color ?? fallback` never reaches the fallback — it
 * yields a function, which then marshals as a block and fails somewhere else
 * entirely, with a message about __NSGlobalBlock__ that names neither the
 * property nor the line.
 */
export function isObjC(v: unknown): boolean {
  return v instanceof ObjCObject;
}

/** Convert an NSString (or anything with -description) to a JS string. */
export function str(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (v instanceof ObjCObject) return v.toString();
  return String(v);
}

// ---------------------------------------------------------------------------
// Argument marshalling
// ---------------------------------------------------------------------------

interface Temps {
  raw: Ptr[]; // +1 pointers to autorelease after the call
  keep: any[]; // values that must stay reachable for the duration of the call
}

function boxObject(v: any, temps: Temps): Ptr {
  if (v === null || v === undefined) return NIL;
  if (v instanceof ObjCObject) return v.ptr;
  if (v instanceof ObjCBlock) return v.ptr;
  const t = typeof v;
  if (t === "string") {
    const p = makeStringRaw(v);
    temps.raw.push(p);
    return p;
  }
  if (t === "boolean") {
    const n = getClass("NSNumber").send("numberWithBool:", v);
    temps.keep.push(n);
    return n.ptr;
  }
  if (t === "number") {
    const n = Number.isInteger(v)
      ? getClass("NSNumber").send("numberWithLongLong:", v)
      : getClass("NSNumber").send("numberWithDouble:", v);
    temps.keep.push(n);
    return n.ptr;
  }
  if (t === "bigint") {
    const n = getClass("NSNumber").send("numberWithLongLong:", v);
    temps.keep.push(n);
    return n.ptr;
  }
  if (t === "function") {
    // A bare function where an object is expected is almost always a block.
    const b = createBlock("v@?", v);
    temps.keep.push(b);
    return b.ptr;
  }
  if (v instanceof Date) {
    const d = getClass("NSDate").send("dateWithTimeIntervalSince1970:", v.getTime() / 1000);
    temps.keep.push(d);
    return d.ptr;
  }
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    temps.keep.push(bytes);
    const d = getClass("NSData").send("dataWithBytes:length:", BigInt(ptr(bytes)), bytes.length);
    temps.keep.push(d);
    return d.ptr;
  }
  if (Array.isArray(v)) {
    const NSNull = getClass("NSNull").send("null");
    const arr = getClass("NSMutableArray").send("arrayWithCapacity:", v.length);
    for (const item of v) arr.send("addObject:", item ?? NSNull);
    temps.keep.push(arr);
    return arr.ptr;
  }
  if (t === "object") {
    const NSNull = getClass("NSNull").send("null");
    const d = getClass("NSMutableDictionary").send("dictionaryWithCapacity:", 8);
    for (const [k, val] of Object.entries(v)) d.send("setObject:forKey:", val ?? NSNull, k);
    temps.keep.push(d);
    return d.ptr;
  }
  throw new TypeError(`cannot convert ${t} to an Objective-C object`);
}

function writeArg(
  dv: DataView,
  info: ArgInfo,
  enc: string,
  v: any,
  temps: Temps,
  what: string,
): void {
  const o = info.offset;
  switch (info.kind) {
    case K.SINT8:
      dv.setInt8(o, Number(v) | 0);
      return;
    case K.UINT8:
      dv.setUint8(o, Number(v) & 0xff);
      return;
    case K.BOOL:
      dv.setUint8(o, v ? 1 : 0);
      return;
    case K.SINT16:
      dv.setInt16(o, Number(v) | 0, le);
      return;
    case K.UINT16:
      dv.setUint16(o, Number(v) & 0xffff, le);
      return;
    case K.SINT32:
      dv.setInt32(o, Number(v) | 0, le);
      return;
    case K.UINT32:
      dv.setUint32(o, Number(v) >>> 0, le);
      return;
    case K.SINT64:
      dv.setBigInt64(o, toI64(v, what), le);
      return;
    case K.UINT64:
      dv.setBigUint64(o, toU64(v, what), le);
      return;
    case K.FLOAT:
      dv.setFloat32(o, Number(v), le);
      return;
    case K.DOUBLE:
      dv.setFloat64(o, Number(v), le);
      return;
    case K.OBJECT:
      dv.setBigUint64(o, boxObject(v, temps), le);
      return;
    case K.CLASS: {
      let p: Ptr = NIL;
      if (typeof v === "string") p = classFor(v);
      else if (v instanceof ObjCObject) p = v.ptr;
      else if (v !== null && v !== undefined) p = unwrap(v);
      dv.setBigUint64(o, p, le);
      return;
    }
    case K.SEL: {
      const p = typeof v === "string" ? selFor(v) : unwrap(v);
      dv.setBigUint64(o, p, le);
      return;
    }
    case K.CHARPTR: {
      if (v === null || v === undefined) {
        dv.setBigUint64(o, NIL, le);
        return;
      }
      if (typeof v === "string") {
        const b = cstr(v);
        temps.keep.push(b);
        dv.setBigUint64(o, BigInt(ptr(b)), le);
        return;
      }
      dv.setBigUint64(o, rawPointer(v, temps), le);
      return;
    }
    case K.BLOCK: {
      if (typeof v === "function") {
        const b = createBlock(blockEncodingFor(enc), v);
        temps.keep.push(b);
        dv.setBigUint64(o, b.ptr, le);
        return;
      }
      dv.setBigUint64(o, v instanceof ObjCBlock ? v.ptr : unwrap(v), le);
      return;
    }
    case K.POINTER:
      dv.setBigUint64(o, rawPointer(v, temps), le);
      return;
    case K.STRUCT:
    case K.UNION:
    case K.ARRAY: {
      const def = structDef(enc);
      if (def) {
        def.write(dv, o, v);
        return;
      }
      // Anonymous structs have no name to look up — Metal encodes MTLClearColor
      // as "{?=dddd}" — so raw bytes are the only way to pass one. Any view
      // works, not just Uint8Array: a Float64Array is the natural way to write
      // four doubles.
      if (ArrayBuffer.isView(v)) {
        const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        if (bytes.length < info.size) {
          throw new TypeError(
            `${what}: ${enc} needs ${info.size} bytes, got ${bytes.length}`,
          );
        }
        new Uint8Array(dv.buffer, dv.byteOffset + o, info.size).set(bytes.subarray(0, info.size));
        return;
      }
      throw new TypeError(
        `no struct converter for ${enc} (${what}); pass a typed array of ${info.size} bytes`,
      );
    }
    case K.VOID:
      return;
    default:
      throw new TypeError(`cannot marshal argument of kind ${KIND_NAMES[info.kind]} (${what})`);
  }
}

function rawPointer(v: any, temps: Temps): Ptr {
  if (v === null || v === undefined) return NIL;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (v instanceof ObjCObject) return v.ptr;
  if (v instanceof ObjCBlock) return v.ptr;
  if (ArrayBuffer.isView(v)) {
    temps.keep.push(v);
    return BigInt(ptr(v as any));
  }
  if (v instanceof ArrayBuffer) {
    const u = new Uint8Array(v);
    temps.keep.push(u);
    return BigInt(ptr(u));
  }
  throw new TypeError("cannot convert value to a pointer");
}

function toI64(v: any, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1n : 0n;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`${what}: expected an integer, got ${v}`);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${what}: ${n} loses precision as a 64-bit integer; pass a BigInt`);
  }
  return BigInt(Math.trunc(n));
}

function toU64(v: any, what: string): bigint {
  const b = toI64(v, what);
  return b < 0n ? BigInt.asUintN(64, b) : b;
}

// ---------------------------------------------------------------------------
// Return marshalling
// ---------------------------------------------------------------------------

function readValue(
  dv: DataView,
  off: number,
  kind: number,
  size: number,
  enc: string,
  plusOne: boolean,
): any {
  switch (kind) {
    case K.VOID:
      return undefined;
    case K.SINT8:
      return dv.getInt8(off);
    case K.UINT8:
      return dv.getUint8(off);
    case K.BOOL:
      return dv.getUint8(off) !== 0;
    case K.SINT16:
      return dv.getInt16(off, le);
    case K.UINT16:
      return dv.getUint16(off, le);
    case K.SINT32:
      return dv.getInt32(off, le);
    case K.UINT32:
      return dv.getUint32(off, le);
    case K.SINT64: {
      const b = dv.getBigInt64(off, le);
      return b >= -9007199254740991n && b <= 9007199254740991n ? Number(b) : b;
    }
    case K.UINT64: {
      const b = dv.getBigUint64(off, le);
      return b <= 9007199254740991n ? Number(b) : b;
    }
    case K.FLOAT:
      return dv.getFloat32(off, le);
    case K.DOUBLE:
      return dv.getFloat64(off, le);
    case K.OBJECT:
    case K.BLOCK:
      return wrap(dv.getBigUint64(off, le), plusOne);
    case K.CLASS:
      return classByPtr(dv.getBigUint64(off, le));
    case K.SEL: {
      const p = dv.getBigUint64(off, le);
      return p === NIL ? null : String(lib.br_selector_name(p));
    }
    case K.CHARPTR: {
      const p = dv.getBigUint64(off, le);
      return p === NIL ? null : readCString(p);
    }
    case K.POINTER:
      return dv.getBigUint64(off, le);
    case K.STRUCT:
    case K.UNION:
    case K.ARRAY: {
      const def = structDef(enc);
      if (def) return def.read(dv, off);
      return new Uint8Array(dv.buffer.slice(dv.byteOffset + off, dv.byteOffset + off + size));
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Method resolution cache
// ---------------------------------------------------------------------------

interface Resolved {
  selPtr: Ptr;
  types: string;
  typesBuf: Uint8Array;
  layout: SigLayout;
  split: SplitEncoding;
  family: string | null;
}

const resolveCache = new Map<Ptr, Map<string, Resolved | null>>();

function resolve(cls: Ptr, selName: string, instance: boolean): Resolved | null {
  let m = resolveCache.get(cls);
  if (!m) {
    m = new Map();
    resolveCache.set(cls, m);
  }
  const key = instance ? selName : "+" + selName;
  const cached = m.get(key);
  if (cached !== undefined) return cached;
  const selPtr = selFor(selName);
  const types = methodSignature(cls, selPtr, instance);
  let r: Resolved | null = null;
  if (types) {
    r = {
      selPtr,
      types,
      typesBuf: cstrCached(types),
      layout: sigLayout(types),
      split: splitEncoding(types),
      family: methodFamily(selName),
    };
  }
  m.set(key, r);
  return r;
}

function suggestions(cls: Ptr, selName: string, instance: boolean): string {
  try {
    const target = selName.replace(/:/g, "").toLowerCase();
    const head = target.slice(0, 5);
    const near = methodNames(cls, instance)
      .filter((s) => {
        const t = s.replace(/:/g, "").toLowerCase();
        return t.startsWith(head) || t.includes(target) || target.includes(t);
      })
      .slice(0, 6);
    return near.length ? `\n  did you mean: ${near.join(", ")}` : "";
  } catch {
    return "";
  }
}

export function methodNames(cls: Ptr | ObjCClass, instance = true): string[] {
  const p = typeof cls === "bigint" ? cls : cls.ptr;
  const out: string[] = [];
  const seen = new Set<string>();
  const cap = 1 << 20;
  const buf = new Uint8Array(cap);
  const dec = new TextDecoder();
  let cur = p;
  for (let depth = 0; cur !== NIL && depth < 16; depth++) {
    buf[0] = 0;
    lib.br_copy_method_list(cur, instance ? 1 : 0, ptr(buf), cap);
    const zero = buf.indexOf(0);
    const text = dec.decode(buf.subarray(0, zero === -1 ? cap : zero));
    for (const line of text.split("\n")) {
      if (!line) continue;
      const name = line.split("\t")[0]!;
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    const sn = lib.br_class_super_name(cur);
    if (!sn) break;
    cur = classFor(String(sn));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export function invoke(
  targetPtr: Ptr,
  lookupCls: Ptr,
  instance: boolean,
  selName: string,
  args: any[],
  receiver?: ObjCObject,
): any {
  // Messaging nil is legal in Obj-C and yields nil/0.
  if (targetPtr === NIL) return null;
  const r = resolve(lookupCls, selName, instance);
  if (!r) {
    const clsName = String(lib.br_object_class_name(lookupCls));
    throw new Error(
      `${instance ? "-" : "+"}[${clsName} ${selName}] is not implemented (unrecognized selector)` +
        suggestions(lookupCls, selName, instance),
    );
  }
  return dispatch(targetPtr, r, args, selName, receiver, NIL);
}

export function invokeSuper(targetPtr: Ptr, superCls: Ptr, selName: string, args: any[]): any {
  const r = resolve(superCls, selName, true);
  if (!r) throw new Error(`super does not implement ${selName}`);
  return dispatch(targetPtr, r, args, selName, undefined, superCls);
}

function dispatch(
  targetPtr: Ptr,
  r: Resolved,
  args: any[],
  selName: string,
  receiver: ObjCObject | undefined,
  superCls: Ptr,
): any {
  const L = r.layout;
  if (args.length !== L.userArgs) {
    throw new TypeError(
      `${selName} expects ${L.userArgs} argument${L.userArgs === 1 ? "" : "s"}, got ${args.length}`,
    );
  }
  statsCalls++;
  const slot = acquire(L.argbufSize, L.retbufSize);
  const temps: Temps = { raw: [], keep: [] };
  try {
    // Slots 0 and 1 (self, _cmd) are filled in by the shim.
    slot.argBytes.fill(0, 0, L.argbufSize);
    for (let i = 0; i < L.userArgs; i++) {
      writeArg(
        slot.argView,
        L.args[i + 2]!,
        r.split.args[i + 2]!,
        args[i],
        temps,
        `${selName} arg ${i}`,
      );
    }
    const rc = superCls
      ? lib.br_msgsend_super(
          targetPtr, superCls, r.selPtr, r.typesBuf, slot.argPtr, slot.retPtr, slot.errPtr,
        )
      : lib.br_msgsend(targetPtr, r.selPtr, r.typesBuf, slot.argPtr, slot.retPtr, slot.errPtr);

    if (rc !== BR_OK) {
      const msg = readErr(slot) ?? `error ${rc}`;
      throw new Error(`${selName}: ${msg}`);
    }

    if (r.family === "init") {
      const p = slot.retView.getBigUint64(0, le);
      if (p === targetPtr) return receiver ? outward(receiver) : wrap(p, true);
      // init returned a different object and took ownership of the receiver.
      if (receiver) receiver._disown();
      return wrap(p, true);
    }

    const plusOne =
      r.family === "alloc" || r.family === "new" || r.family === "copy" ||
      r.family === "mutableCopy";
    return readValue(slot.retView, 0, L.ret.kind, L.ret.size, r.split.ret, plusOne);
  } finally {
    // Release rather than autorelease. An argument only has to outlive the
    // call — a callee that keeps it is required to retain it — and this is
    // exactly what ARC does with a temporary at the end of a statement.
    // Autoreleasing instead would make every marshalled string depend on a
    // pool drain, which is how an app ends up at a gigabyte of RSS.
    for (const p of temps.raw) lib.br_release(p);
    releaseSlot();
  }
}

// ---------------------------------------------------------------------------
// Callbacks into JS: one fixed-signature entry point for every trampoline
// ---------------------------------------------------------------------------

interface MethodSlot {
  selector: string;
  layout: SigLayout;
  split: SplitEncoding;
  types: string;
  isBlock: boolean;
  fn?: (...a: any[]) => any; // blocks carry their own function
  /**
   * A stateless delegate's handler, kept with its class: what answers when an instance's own
   * handlers have been collected. See {@link DelegateOptions.stateless}.
   */
  fallback?: (...a: any[]) => any;
}

const methodSlots: MethodSlot[] = [
  { selector: "", layout: null as any, split: null as any, types: "", isBlock: false },
];
// Per-instance handler tables, addressed by the token the trampoline is given.
//
// These are **WeakRefs on purpose**. A delegate's handlers close over the object
// that owns them (a Window closes over itself in windowWillClose_), and that
// object holds the delegate wrapper. If this array held the table strongly it
// would root the whole cycle — global array -> table -> closure -> Window ->
// delegate wrapper -> table — so the wrapper's finalizer could never run and
// every window ever opened would stay alive. The table is kept alive by the
// delegate wrapper's own `__handlers` property instead, which is exactly the
// lifetime we want: handlers live as long as the delegate does.
const instanceHandlers: (WeakRef<Record<string, any>> | undefined)[] = [undefined];
const freeInstanceTokens: number[] = [];

const delegateFinalizers = new FinalizationRegistry<number>((token) => {
  instanceHandlers[token] = undefined;
  freeInstanceTokens.push(token);
});

function decodeArgs(slot: MethodSlot, argbuf: number): any[] {
  const L = slot.layout;
  const dv = new DataView(toArrayBuffer(asPointer(argbuf), 0, L.argbufSize));
  const skip = slot.isBlock ? 1 : 2; // block: [block]; method: [self, _cmd]
  const out: any[] = [];
  for (let i = skip; i < L.nargs; i++) {
    const info = L.args[i]!;
    out.push(readValue(dv, info.offset, info.kind, info.size, slot.split.args[i]!, false));
  }
  return out;
}

function encodeReturn(slot: MethodSlot, retbuf: number, value: any): void {
  const R = slot.layout.ret;
  if (R.kind === K.VOID || R.size === 0) return;
  // Mirror the trampoline's rule: an aggregate's buffer is exactly its size,
  // while a narrow scalar's is widened to a full ffi_arg.
  const aggregate = R.kind === K.STRUCT || R.kind === K.UNION || R.kind === K.ARRAY;
  const width = aggregate ? R.size : Math.max(R.size, 8);
  const dv = new DataView(toArrayBuffer(asPointer(retbuf), 0, width));
  const temps: Temps = { raw: [], keep: [] };
  const info: ArgInfo = { kind: R.kind, size: R.size, align: R.align, offset: 0 };
  try {
    writeArg(dv, info, slot.split.ret, value, temps, `${slot.selector} return`);
  } catch (e) {
    console.error(`[objc] failed to encode the return value of ${slot.selector}:`, e);
  }
  // A returned object must outlive the callback; hand AppKit a +0 autoreleased
  // object exactly as a hand-written method would.
  for (const p of temps.raw) lib.br_autorelease(p);
}

const dispatchCallback = new JSCallback(
  (methodToken: number, instToken: number, argbuf: number, retbuf: number) => {
    const slot = methodSlots[methodToken];
    if (!slot) return;
    try {
      let fn = slot.fn;
      let self: any;
      if (!slot.isBlock) {
        const table = instanceHandlers[instToken]?.deref();
        if (table === undefined && slot.fallback) {
          // A stateless delegate outliving its wrapper — a view AppKit is still tearing down —
          // answers from its class, as a hand-written method would.
          encodeReturn(slot, retbuf, slot.fallback.apply(undefined, decodeArgs(slot, argbuf)));
          return;
        }
        if (table === undefined) {
          // The delegate's JS side has been collected while Obj-C still holds
          // the object. Nothing sensible to call; say so rather than silently
          // dropping events, since it means an owner was released too early.
          if (!warnedTokens.has(instToken)) {
            warnedTokens.add(instToken);
            console.warn(
              `[objc] ${slot.selector} arrived for a delegate whose JS handlers ` +
                `have been garbage collected — keep a reference to the delegate ` +
                `(or its owner) for as long as Obj-C holds it.`,
            );
          }
          return;
        }
        fn = table[slot.selector];
        if (typeof fn !== "function") return;
        const dv = new DataView(toArrayBuffer(asPointer(argbuf), 0, 8));
        self = wrap(dv.getBigUint64(0, le), false);
      }
      if (typeof fn !== "function") return;
      encodeReturn(slot, retbuf, fn.apply(self, decodeArgs(slot, argbuf)));
    } catch (e) {
      // An exception must never unwind into Obj-C.
      console.error(`[objc] uncaught error in ${slot.selector || "<block>"}:`, e);
    }
  },
  { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
);

// Hard reference — if this were collected AppKit would jump into freed memory.
const KEEP_ALIVE = new Set<any>([dispatchCallback]);
const warnedTokens = new Set<number>();

// ---------------------------------------------------------------------------
// Delegates & runtime subclasses
// ---------------------------------------------------------------------------

export interface DelegateOptions {
  /** Protocols to consult for type encodings and to declare conformance to. */
  protocols?: string[];
  /** Explicit encodings for selectors not found in any protocol. */
  types?: Record<string, string>;
  /** Superclass; defaults to NSObject. */
  superclass?: string;
  /** Base name used for the generated Obj-C class. */
  name?: string;
  /**
   * Every handler is a constant answer that needs no instance — a view that says it is flipped.
   * They are kept with the class as well as the instance, so an object whose JavaScript wrapper
   * has been collected while AppKit still holds it (a view being torn down after its owner let
   * go) still answers, rather than answering nothing and warning. Only for handlers that capture
   * nothing: the first set given for a class answers for every instance of it.
   */
  stateless?: boolean;
}

// Searched by default so most delegates need no configuration at all.
const DEFAULT_PROTOCOLS = [
  "NSApplicationDelegate",
  "NSWindowDelegate",
  "NSTableViewDataSource",
  "NSTableViewDelegate",
  "NSOutlineViewDataSource",
  "NSOutlineViewDelegate",
  "NSTextFieldDelegate",
  "NSTextViewDelegate",
  "NSTextDelegate",
  "NSControlTextEditingDelegate",
  "NSMenuDelegate",
  "NSMenuItemValidation",
  "NSSplitViewDelegate",
  "NSToolbarDelegate",
  "NSToolbarItemValidation",
  "NSTabViewDelegate",
  "NSComboBoxDelegate",
  "NSComboBoxDataSource",
  "NSSearchFieldDelegate",
  "NSCollectionViewDelegate",
  "NSCollectionViewDataSource",
  "NSCollectionViewDelegateFlowLayout",
  "NSDraggingDestination",
  "NSDraggingSource",
  "NSPathControlDelegate",
  "NSOpenSavePanelDelegate",
  "NSUserInterfaceValidations",
];

const FALLBACK_CLASSES = ["NSObject", "NSResponder", "NSView", "NSWindow", "NSApplication", "NSControl"];

function findTypes(
  selector: string,
  protocols: string[],
  explicit?: Record<string, string>,
): string | null {
  if (explicit?.[selector]) return explicit[selector]!;
  const s = selFor(selector);
  for (const p of protocols) {
    for (const required of [true, false]) {
      const t = protocolMethodSignature(p, s, required, true);
      if (t) return t;
    }
  }
  // Informal protocols and NSObject overrides: borrow the encoding from any
  // class in the runtime that already implements this selector.
  for (const c of FALLBACK_CLASSES) {
    const cls = classFor(c);
    if (cls !== NIL) {
      const t = methodSignature(cls, s, true);
      if (t) return t;
    }
  }
  return null;
}

let classCounter = 0;
const shapeCache = new Map<string, { cls: Ptr; tokens: Record<string, number> }>();

/**
 * Build (or reuse) an Obj-C class implementing `handlers` and return an instance
 * whose methods call straight into JavaScript.
 *
 *   const d = createDelegate({ windowWillClose_: () => app.quit() });
 *   win.setDelegate_(d);
 *
 * One Obj-C class is created per distinct *shape* (set of selectors), because
 * registered classes can never be freed; per-instance handlers are addressed by
 * an associated-object token.
 */
export function createDelegate(
  handlers: Record<string, (...args: any[]) => any>,
  options: DelegateOptions = {},
): any {
  const protocols = [...(options.protocols ?? []), ...DEFAULT_PROTOCOLS];
  const superclass = options.superclass ?? "NSObject";
  const selectors = Object.keys(handlers).map(toSelector).sort();
  const shapeKey =
    `${superclass}|${(options.protocols ?? []).join(",")}|${selectors.join(",")}` +
    (options.stateless ? "|stateless" : "");

  let shape = shapeCache.get(shapeKey);
  if (!shape) {
    const clsName = `BRJS_${options.name ?? "Delegate"}_${classCounter++}`;
    const cls = lib.br_class_create(cstr(clsName), cstr(superclass)) as bigint;
    if (cls === NIL) throw new Error(`could not create Obj-C class ${clsName}`);
    for (const p of options.protocols ?? []) lib.br_class_add_protocol(cls, cstr(p));

    const tokens: Record<string, number> = {};
    for (const selector of selectors) {
      const types = findTypes(selector, protocols, options.types);
      if (!types) {
        throw new Error(
          `cannot determine the Obj-C type encoding for "${selector}".\n` +
            `  Pass it explicitly: createDelegate(handlers, { types: { "${selector}": "v@:@" } })`,
        );
      }
      const token = methodSlots.length;
      const handler = Object.entries(handlers).find(([key]) => toSelector(key) === selector)?.[1];
      methodSlots.push({
        selector,
        layout: sigLayout(types),
        split: splitEncoding(types),
        types,
        isBlock: false,
        ...(options.stateless && handler ? { fallback: handler } : {}),
      });
      const rc = lib.br_class_add_method(
        cls, selFor(selector), cstrCached(types), dispatchCallback.ptr, token, 0,
      );
      if (rc !== BR_OK) throw new Error(`could not add ${selector} (${types}) to ${clsName}`);
      tokens[selector] = token;
    }
    lib.br_class_register(cls);
    shape = { cls, tokens };
    shapeCache.set(shapeKey, shape);
  }

  const table: Record<string, any> = {};
  for (const [k, v] of Object.entries(handlers)) table[toSelector(k)] = v;
  const reusedToken = freeInstanceTokens.pop();
  const instToken = reusedToken ?? instanceHandlers.length;
  const ref = new WeakRef(table);
  if (reusedToken === undefined) instanceHandlers.push(ref);
  else instanceHandlers[reusedToken] = ref;

  const allocated = invoke(shape.cls, shape.cls, false, "alloc", []) as ObjCObject;
  const obj = allocated.send("init") as ObjCObject;
  lib.br_object_set_token(obj.ptr, instToken);
  // This property is what keeps the handler table alive; see instanceHandlers.
  (obj as any).__handlers = table;
  delegateFinalizers.register(table, instToken);
  return obj;
}

/** Replace the handler table of an existing delegate in place. */
export function updateDelegate(
  delegate: ObjCObject,
  handlers: Record<string, (...args: any[]) => any>,
): void {
  const token = lib.br_object_get_token(delegate.ptr);
  const table = instanceHandlers[Number(token)]?.deref();
  if (!table) throw new Error("not a JS delegate");
  for (const [k, v] of Object.entries(handlers)) table[toSelector(k)] = v;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Turn "@?" (an opaque block argument) into a usable default encoding. */
function blockEncodingFor(enc: string): string {
  return enc === "@?" ? "v@?" : enc;
}

const liveBlocks = new Set<ObjCBlock>();
// Reusable callback-slot indices, returned by ObjCBlock.dispose().
const freeSlots: number[] = [];

export class ObjCBlock {
  readonly ptr: Ptr;
  readonly token: number;
  #released = false;
  constructor(p: Ptr, token: number) {
    this.ptr = p;
    this.token = token;
  }
  dispose() {
    if (this.#released) return;
    this.#released = true;
    liveBlocks.delete(this);
    // Drop the JS function too, or a long-running app that makes a block per
    // sheet keeps every closure it ever created.
    const slot = methodSlots[this.token];
    if (slot) slot.fn = undefined;
    freeSlots.push(this.token);
    lib.br_block_release(this.ptr);
  }
}

/**
 * Create an Obj-C block from a JS function.
 *
 * `types` is a block type encoding: the return type, then "@?" for the block
 * itself, then the argument types — e.g. "v@?q" is `void (^)(NSInteger)`.
 */
export function createBlock(types: string, fn: (...args: any[]) => any): ObjCBlock {
  const slot: MethodSlot = {
    selector: "<block>",
    layout: sigLayout(types),
    split: splitEncoding(types),
    types,
    isBlock: true,
    fn,
  };
  const reused = freeSlots.pop();
  const token = reused ?? methodSlots.length;
  if (reused === undefined) methodSlots.push(slot);
  else methodSlots[reused] = slot;
  const p = lib.br_block_create(cstrCached(types), dispatchCallback.ptr, token) as bigint;
  if (p === NIL) throw new Error(`could not create a block for encoding ${types}`);
  const b = new ObjCBlock(p, token);
  liveBlocks.add(b); // blocks are freed explicitly, never by GC
  return b;
}

// ---------------------------------------------------------------------------
// Deep conversion to plain JS
// ---------------------------------------------------------------------------

export function toJS(v: any): any {
  if (!(v instanceof ObjCObject)) return v;
  const p = v.ptr;
  if (p === NIL) return null;
  if (isKind(p, "NSString")) return nsstringToJS(p);
  if (isKind(p, "NSNumber")) {
    // -objCType returns a `char *`, which Layer 2 already decodes to a string.
    const t = String(v.send("objCType") ?? "");
    if (t === "c" || t === "B") return v.send("boolValue");
    if (t === "d" || t === "f") return v.send("doubleValue");
    return v.send("longLongValue");
  }
  if (isKind(p, "NSNull")) return null;
  if (isKind(p, "NSArray")) {
    const n = Number(v.send("count"));
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = toJS(v.send("objectAtIndex:", i));
    return out;
  }
  if (isKind(p, "NSDictionary")) {
    const keys = v.send("allKeys");
    const n = Number(keys.send("count"));
    const out: Record<string, any> = {};
    for (let i = 0; i < n; i++) {
      const k = keys.send("objectAtIndex:", i);
      out[String(toJS(k))] = toJS(v.send("objectForKey:", k));
    }
    return out;
  }
  if (isKind(p, "NSDate")) return new Date(Number(v.send("timeIntervalSince1970")) * 1000);
  if (isKind(p, "NSData")) {
    const len = Number(v.send("length"));
    const bytes = v.send("bytes") as bigint;
    return new Uint8Array(toArrayBuffer(asPointer(bytes), 0, len)).slice();
  }
  return v;
}

const kindCache = new Map<string, Ptr>();
function isKind(p: Ptr, cls: string): boolean {
  let c = kindCache.get(cls);
  if (c === undefined) {
    c = classFor(cls);
    kindCache.set(cls, c);
  }
  return lib.br_is_kind_of(p, c) !== 0;
}

// ---------------------------------------------------------------------------
// C symbols & global constants
// ---------------------------------------------------------------------------

/** Read a global Obj-C object constant such as NSFontAttributeName. */
export function globalObject(symbol: string): any {
  const addr = lib.br_dlsym(cstrCached(symbol)) as bigint;
  if (addr === NIL) return null;
  const dv = new DataView(toArrayBuffer(asPointer(addr), 0, 8));
  return wrap(dv.getBigUint64(0, le), false);
}

export function globalDouble(symbol: string): number | null {
  const addr = lib.br_dlsym(cstrCached(symbol)) as bigint;
  if (addr === NIL) return null;
  return new DataView(toArrayBuffer(asPointer(addr), 0, 8)).getFloat64(0, le);
}

export function symbolAddress(symbol: string): Ptr {
  return lib.br_dlsym(cstrCached(symbol)) as bigint;
}

/**
 * Bind an exported C function.
 *
 * `types` is an Obj-C style encoding with the return type first and *no*
 * self/_cmd slots — e.g. `cfunction("CGColorCreateGenericRGB", "^{CGColor=}dddd")`.
 * Returns null if the symbol does not exist (many "functions" in the headers are
 * static inlines and have no symbol at all).
 */
export function cfunction(
  symbol: string,
  types: string,
): ((...args: any[]) => any) | null {
  const addr = lib.br_dlsym(cstrCached(symbol)) as bigint;
  if (addr === NIL) return null;
  const layout = sigLayout(types);
  const split = splitEncoding(types);
  const typesBuf = cstrCached(types);
  return (...args: any[]) => {
    if (args.length !== layout.nargs) {
      throw new TypeError(`${symbol} expects ${layout.nargs} arguments, got ${args.length}`);
    }
    const slot = acquire(layout.argbufSize, layout.retbufSize);
    const temps: Temps = { raw: [], keep: [] };
    try {
      slot.argBytes.fill(0, 0, layout.argbufSize);
      for (let i = 0; i < layout.nargs; i++) {
        writeArg(slot.argView, layout.args[i]!, split.args[i]!, args[i], temps, `${symbol} arg ${i}`);
      }
      const rc = lib.br_call_function(addr, typesBuf, slot.argPtr, slot.retPtr, slot.errPtr);
      if (rc !== BR_OK) throw new Error(`${symbol}: ${readErr(slot) ?? `error ${rc}`}`);
      return readValue(slot.retView, 0, layout.ret.kind, layout.ret.size, split.ret, false);
    } finally {
      for (const p of temps.raw) lib.br_autorelease(p);
      releaseSlot();
    }
  };
}

// ---------------------------------------------------------------------------
// The root proxy
// ---------------------------------------------------------------------------

export const objc: Record<string, any> = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined; // never look thenable to `await`
      return getClass(prop);
    },
    has(_t, prop) {
      return typeof prop === "string" && classFor(prop) !== NIL;
    },
  },
);

// ---------------------------------------------------------------------------
// Pools, stats, misc
// ---------------------------------------------------------------------------

export function withPool<T>(fn: () => T): T {
  lib.br_autorelease_pool_push();
  try {
    return fn();
  } finally {
    lib.br_autorelease_pool_pop();
  }
}

/** Drain the base autorelease pool. The run loop does this every iteration. */
export function drainPool(): boolean {
  return lib.br_autorelease_pool_recycle() !== 0;
}

export function stats() {
  return {
    wrappersCreated: statsWrapped,
    live: liveObjects.size,
    disposed: statsReleased,
    calls: statsCalls,
    methodSlots: methodSlots.length - 1,
    delegates: instanceHandlers.filter((r) => r?.deref() !== undefined).length,
    blocks: liveBlocks.size,
    classes: shapeCache.size,
  };
}

export { lib, K, KIND_NAMES, STRUCTS, NIL };
export type { Ptr };
