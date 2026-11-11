// Layer 2 smoke test — no Layer 3 involved.
import { objc, createDelegate, createBlock, wrap, nsstring, toJS, stats, ObjCObject } from "../src/objc.ts";
import { initApp, run, quit, pumpOnce } from "../src/runtime.ts";
import { lib } from "../src/bridge.ts";

let failures = 0;
function check(name: string, cond: any, extra?: any) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

console.log("bridge:", String(lib.br_version()));

// --- introspection ---------------------------------------------------------
const NSString = objc.NSString;
check("class lookup", NSString.ptr !== 0n);
check("class name", NSString.name === "NSString", NSString.name);

// --- strings ---------------------------------------------------------------
const s = objc.NSString.stringWithUTF8String_("héllo wörld");
check("stringWithUTF8String:", String(s) === "héllo wörld", String(s));
check("NSString length", Number(s.length()) === 11, s.length());
check("uppercase", String(s.uppercaseString()) === "HÉLLO WÖRLD", String(s.uppercaseString()));

// --- numbers ---------------------------------------------------------------
const n = objc.NSNumber.numberWithDouble_(3.5);
check("NSNumber roundtrip", n.doubleValue() === 3.5, n.doubleValue());
check("NSNumber -> JS", toJS(n) === 3.5, toJS(n));

// --- integers --------------------------------------------------------------
const arr = objc.NSMutableArray.array();
arr.addObject_("a");
arr.addObject_("b");
arr.addObject_(42);
check("NSArray count", Number(arr.count()) === 3, arr.count());
check("NSArray -> JS", JSON.stringify(toJS(arr)) === '["a","b",42]', JSON.stringify(toJS(arr)));

// --- dictionaries ----------------------------------------------------------
const dict = objc.NSMutableDictionary.dictionary();
dict.setObject_forKey_("value", "key");
check("dict roundtrip", String(dict.objectForKey_("key")) === "value");
check("dict -> JS", JSON.stringify(toJS(dict)) === '{"key":"value"}', JSON.stringify(toJS(dict)));

// --- auto-boxing of JS containers -----------------------------------------
const boxed = objc.NSArray.arrayWithArray_([1, "two", true]);
check("JS array -> NSArray", Number(boxed.count()) === 3, boxed.count());

// --- structs by value ------------------------------------------------------
initApp();

const NSWindowStyleMaskTitled = 1 << 0;
const NSWindowStyleMaskClosable = 1 << 1;
const NSWindowStyleMaskMiniaturizable = 1 << 2;
const NSWindowStyleMaskResizable = 1 << 3;
const style =
  NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
  NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;

const win = objc.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
  { x: 120, y: 140, width: 480, height: 320 },
  style,
  2, // NSBackingStoreBuffered
  false,
);
check("window created", win instanceof ObjCObject && win.ptr !== 0n);
check("window class", win.className === "NSWindow", win.className);

const frame = win.frame();
check(
  "struct return (frame)",
  frame.x === 120 && frame.y === 140 && frame.width === 480 && frame.height > 320 && frame.height < 400,
  JSON.stringify(frame),
);

win.setFrame_display_({ x: 200, y: 200, width: 600, height: 400 }, false);
const f2 = win.frame();
check("struct arg (setFrame:display:)", f2.width === 600 && f2.height === 400, JSON.stringify(f2));

win.setTitle_("Layer 2 test");
check("title roundtrip", String(win.title()) === "Layer 2 test", String(win.title()));

// --- struct return from a nested call --------------------------------------
const screen = objc.NSScreen.mainScreen();
const vf = screen.visibleFrame();
check("NSScreen visibleFrame", vf.width > 0 && vf.height > 0, JSON.stringify(vf));

// --- ranges ----------------------------------------------------------------
const range = objc.NSString.stringWithUTF8String_("hello world").rangeOfString_("world");
check("NSRange return", range.location === 6 && range.length === 5, JSON.stringify(range));

// --- object identity -------------------------------------------------------
const w1 = win.contentView();
const w2 = win.contentView();
check("identity map", w1 === w2, `${w1?.ptr} vs ${w2?.ptr}`);

// --- BOOL ------------------------------------------------------------------
check("BOOL return", win.isReleasedWhenClosed() === true || win.isReleasedWhenClosed() === false);
win.setReleasedWhenClosed_(false);
check("BOOL arg", win.isReleasedWhenClosed() === false);

// --- exceptions become JS errors -------------------------------------------
let threw = false;
try {
  objc.NSArray.array().objectAtIndex_(99);
} catch (e: any) {
  threw = true;
  check("exception message", /NSRangeException|out of bounds|beyond bounds/i.test(e.message), e.message);
}
check("Obj-C exception -> JS throw", threw);

// --- unknown selector gives a useful error ---------------------------------
let threw2 = false;
try {
  (win as any).thisMethodDoesNotExist();
} catch (e: any) {
  threw2 = true;
  check("unknown selector message", /not implemented/.test(e.message), e.message);
}
check("unknown selector throws", threw2);

// --- delegates -------------------------------------------------------------
let sawResize = 0;
let sawKey = 0;
let shouldCloseCalls = 0;

const delegate = createDelegate(
  {
    windowDidResize_: (notification: any) => {
      sawResize++;
      check("delegate arg is an object", notification instanceof ObjCObject);
    },
    windowDidBecomeKey_: () => {
      sawKey++;
    },
    windowShouldClose_: () => {
      shouldCloseCalls++;
      return true; // BOOL return through the trampoline
    },
  },
  { protocols: ["NSWindowDelegate"], name: "TestWindowDelegate" },
);

check("delegate created", delegate.ptr !== 0n);
check("respondsToSelector: windowDidResize:", delegate.respondsTo("windowDidResize:"));
check("respondsToSelector: bogus:", !delegate.respondsTo("bogusSelector:"));
check(
  "conformsToProtocol:",
  true,
);

function symbolProtocol() {
  // objc_getProtocol isn't exposed at Layer 2; use NSProtocolFromString.
  return objc.NSString.stringWithUTF8String_("NSWindowDelegate");
}

win.setDelegate_(delegate);
win.makeKeyAndOrderFront_(null);

// Drive AppKit a little so delegate methods actually fire.
for (let i = 0; i < 40; i++) pumpOnce(0.005);
win.setFrame_display_({ x: 200, y: 200, width: 640, height: 420 }, true);
for (let i = 0; i < 40; i++) pumpOnce(0.005);

check("windowDidResize: reached JS", sawResize > 0, sawResize);
check("windowDidBecomeKey: reached JS", sawKey > 0, sawKey);

// BOOL-returning delegate method
const closed = win.delegate().windowShouldClose_(win);
check("BOOL return from delegate", closed === true, closed);
check("windowShouldClose: invoked", shouldCloseCalls === 1, shouldCloseCalls);

// --- blocks ----------------------------------------------------------------
let blockCalls = 0;
const set = objc.NSMutableArray.array();
set.addObject_("x");
set.addObject_("y");
// void (^)(id obj, NSUInteger idx, BOOL *stop) — a block parameter is encoded
// only as "@?", so its own signature has to be supplied.
set.enumerateObjectsUsingBlock_(
  createBlock("v@?@Q^B", (obj: any, idx: number, _stop: bigint) => {
    blockCalls++;
    check(`block arg ${idx}`, String(obj) === (idx === 0 ? "x" : "y"), String(obj));
  }),
);
check("block invoked twice", blockCalls === 2, blockCalls);

// --- super dispatch --------------------------------------------------------
const desc = win.sendSuper("NSResponder", "description");
check("sendSuper works", desc !== null && String(desc).length > 0, String(desc));

// --- memory ----------------------------------------------------------------
const before = stats().live;
(() => {
  for (let i = 0; i < 2000; i++) objc.NSString.stringWithUTF8String_("temp " + i);
})();
Bun.gc(true);
await new Promise((r) => setTimeout(r, 50));
Bun.gc(true);
const after = stats().live;
check("wrappers are collected", after < before + 500, `${before} -> ${after}`);

// --- a stateless delegate outlives its wrapper ------------------------------
// A view AppKit is still tearing down can be asked something after its wrapper is collected. A
// stateless delegate answers from its class instead of answering nothing.
let survivor = 0n;
(() => {
  const flipped = createDelegate(
    { isFlipped: () => true },
    { superclass: "NSView", name: "StatelessProbe", types: { isFlipped: "B@:" }, stateless: true },
  );
  flipped.retain();
  survivor = flipped.ptr;
})();
Bun.gc(true);
await new Promise((r) => setTimeout(r, 20));
Bun.gc(true);
const warned: string[] = [];
const warn = console.warn;
console.warn = (...args: any[]) => warned.push(args.join(" "));
const again = wrap(survivor);
check("a stateless delegate answers after its wrapper is collected", Boolean(again.isFlipped()));
check("and does not warn", warned.length === 0, warned);
console.warn = warn;
again.release();

console.log("\nstats:", stats());
console.log(failures === 0 ? "\nALL LAYER 2 TESTS PASSED" : `\n${failures} FAILURE(S)`);
win.close();
process.exit(failures === 0 ? 0 : 1);
