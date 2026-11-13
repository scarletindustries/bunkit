// E5: display-link callbacks from NSView and NSScreen, in the default and tracking modes.
//
// Run twice over: once naming the modes with strings made at runtime, as the first version of this
// experiment did, and once with the frameworks' own constants. The strings see nothing, for two
// reasons that have nothing to do with display links:
//
// - the default mode's name is "kCFRunLoopDefaultMode"; "NSDefaultRunLoopMode" names an empty
//   mode of its own, so running it runs nothing;
// - CFRunLoopAddSource and friends recognise the common modes by pointer
//   (`modeName == kCFRunLoopCommonModes`), so an equal string made at runtime is taken as an
//   ordinary mode called "kCFRunLoopCommonModes", which nothing ever runs. (NSRunLoop's
//   -addTimer:forMode: compares by value, which is why E1's NSTimer still fired.)
import { initApp } from "../../../src/runtime.ts";
import { objc, createDelegate, globalObject } from "../../../src/objc.ts";
initApp();
objc.NSApplication.sharedApplication().activateIgnoringOtherApps_(true);
const window = objc.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_({ x: 200, y: 200, width: 300, height: 200 }, 15, 2, false);
window.contentView().setWantsLayer_(true);
window.makeKeyAndOrderFront_(null);
window.orderFrontRegardless();

function measure(modes: { common: any; default: any; tracking: any }) {
  const counts: Record<string, number> = { view: 0, screen: 0 };
  const mk = (name: string) => createDelegate({ "frame:": () => { counts[name]!++; } }, { types: { "frame:": "v@:@" }, name: `Link_${name}` });
  const tv = mk("view"), ts = mk("screen");
  const viewLink = window.contentView().displayLinkWithTarget_selector_(tv, "frame:");
  viewLink.addToRunLoop_forMode_(objc.NSRunLoop.mainRunLoop(), modes.common);
  const screenLink = window.screen().displayLinkWithTarget_selector_(ts, "frame:");
  screenLink.addToRunLoop_forMode_(objc.NSRunLoop.mainRunLoop(), modes.common);
  const run = (mode: any, ms: number) => {
    const until = objc.NSDate.dateWithTimeIntervalSinceNow_(ms / 1000);
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const ev = objc.NSApplication.sharedApplication().nextEventMatchingMask_untilDate_inMode_dequeue_(BigInt("0xffffffffffffffff"), until, mode, true);
      if (ev) objc.NSApplication.sharedApplication().sendEvent_(ev);
    }
  };
  run(modes.default, 300);
  const a = { ...counts };
  run(modes.default, 1000);
  const defaultModeSecond = { view: counts.view! - a.view!, screen: counts.screen! - a.screen! };
  const b = { ...counts };
  run(modes.tracking, 1000);
  const trackingModeSecond = { view: counts.view! - b.view!, screen: counts.screen! - b.screen! };
  viewLink.invalidate();
  screenLink.invalidate();
  return { defaultModeSecond, trackingModeSecond };
}

const strings = measure({ common: "kCFRunLoopCommonModes", default: "NSDefaultRunLoopMode", tracking: "NSEventTrackingRunLoopMode" });
const constants = measure({
  common: globalObject("NSRunLoopCommonModes"),
  default: globalObject("NSDefaultRunLoopMode"),
  tracking: globalObject("NSEventTrackingRunLoopMode"),
});
console.log(JSON.stringify({
  visible: Boolean(window.isVisible()),
  maximumFramesPerSecond: Number(window.screen().maximumFramesPerSecond()),
  modesAsStrings: strings,
  modesAsConstants: constants,
}));
process.exit(0);
