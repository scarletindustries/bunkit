import { initApp } from "../../../src/runtime.ts";
import { objc, createDelegate } from "../../../src/objc.ts";
initApp();
objc.NSApplication.sharedApplication().activateIgnoringOtherApps_(true);
const window = objc.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_({ x: 200, y: 200, width: 300, height: 200 }, 15, 2, false);
window.contentView().setWantsLayer_(true);
window.makeKeyAndOrderFront_(null);
window.orderFrontRegardless();
const counts: Record<string, number> = { view: 0, screen: 0 };
const mk = (name: string) => createDelegate({ "frame:": () => { counts[name]!++; } }, { types: { "frame:": "v@:@" }, name: `Link_${name}` });
const tv = mk("view"), ts = mk("screen");
const viewLink = window.contentView().displayLinkWithTarget_selector_(tv, "frame:");
viewLink.addToRunLoop_forMode_(objc.NSRunLoop.mainRunLoop(), "kCFRunLoopCommonModes");
const screenLink = window.screen().displayLinkWithTarget_selector_(ts, "frame:");
screenLink.addToRunLoop_forMode_(objc.NSRunLoop.mainRunLoop(), "kCFRunLoopCommonModes");
const run = (mode: string, ms: number) => {
  const until = objc.NSDate.dateWithTimeIntervalSinceNow_(ms / 1000);
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const ev = objc.NSApplication.sharedApplication().nextEventMatchingMask_untilDate_inMode_dequeue_(BigInt("0xffffffffffffffff"), until, mode, true);
    if (ev) objc.NSApplication.sharedApplication().sendEvent_(ev);
  }
};
run("NSDefaultRunLoopMode", 500);
const a = { ...counts };
run("NSDefaultRunLoopMode", 1000);
const def = { view: counts.view - a.view, screen: counts.screen - a.screen };
const b = { ...counts };
run("NSEventTrackingRunLoopMode", 1000);
const track = { view: counts.view - b.view, screen: counts.screen - b.screen };
console.log(JSON.stringify({ visible: Boolean(window.isVisible()), occlusion: Number(window.occlusionState()), defaultModeSecond: def, trackingModeSecond: track }));
process.exit(0);
