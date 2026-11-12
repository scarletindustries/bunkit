// A real NSMenu, popped up from JS and cancelled a second later by a common-modes timer: which
// run loop mode is it in, does the timer reach JS, and does anything of Bun's run?
import { initApp } from "../../../src/runtime.ts";
import { objc, createDelegate, str } from "../../../src/objc.ts";
initApp();
objc.NSApplication.sharedApplication().activateIgnoringOtherApps_(true);
const menu = objc.NSMenu.alloc().initWithTitle_("Test");
menu.addItemWithTitle_action_keyEquivalent_("One", null, "");
menu.addItemWithTitle_action_keyEquivalent_("Two", null, "");
let ticks = 0, bun = 0, inMenu = false, menuTicks = 0;
const modes = new Map<string, number>();
let reentered = 0;
const target = createDelegate({
  "tick:": () => {
    ticks++;
    const mode = str(objc.NSRunLoop.currentRunLoop().currentMode());
    modes.set(mode, (modes.get(mode) ?? 0) + 1);
    if (inMenu) { menuTicks++; reentered++; }
    if (inMenu && menuTicks >= 100) menu.cancelTracking();
  },
}, { types: { "tick:": "v@:@" }, name: "MenuTick" });
const timer = objc.NSTimer.timerWithTimeInterval_target_selector_userInfo_repeats_(0.01, target, "tick:", null, true);
objc.NSRunLoop.currentRunLoop().addTimer_forMode_(timer, "kCFRunLoopCommonModes");
setInterval(() => bun++, 10);
await Bun.sleep(200);
const bunBefore = bun;
const t0 = performance.now();
inMenu = true;
// Blocks until the menu is dismissed — exactly as a menu opened by a click does.
menu.popUpMenuPositioningItem_atLocation_inView_(null, { x: 400, y: 400 }, null);
inMenu = false;
console.log(JSON.stringify({
  menuOpenMs: Math.round(performance.now() - t0),
  timerCallbacksIntoJsWhileOpen: menuTicks,
  bunIntervalTicksWhileOpen: bun - bunBefore,
  modesSeen: Object.fromEntries(modes),
}));
process.exit(0);
