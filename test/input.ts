// Synthetic input: post real NSEvents into the app and check they come out the
// other side as JS callbacks. This is the end-to-end proof that the UI is not
// just drawn but actually usable.

import { objc } from "../src/objc.ts";
import { initApp, pumpOnce } from "../src/runtime.ts";
import {
  Button,
  Checkbox,
  Container,
  HStack,
  Label,
  Table,
  TextField,
  VStack,
  Window,
  input,
} from "../src/ui/index.ts";
import { constants as C } from "../src/ui/appkit.ts";

let failures = 0;
function check(name: string, cond: any, extra?: any) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

function settle(n = 10, s = 0.004) {
  for (let i = 0; i < n; i++) pumpOnce(s);
}

initApp();

const EventType = {
  LeftMouseDown: Number(C.NSEventTypeLeftMouseDown),
  LeftMouseUp: Number(C.NSEventTypeLeftMouseUp),
  MouseMoved: Number(C.NSEventTypeMouseMoved),
  KeyDown: Number(C.NSEventTypeKeyDown),
  KeyUp: Number(C.NSEventTypeKeyUp),
};

/**
 * Post a full click.
 *
 * Both events must be queued *before* pumping: -[NSCell trackMouse:...] spins
 * its own nested run loop on mouse-down and does not return until it sees the
 * matching mouse-up. Posting the up afterwards would deadlock, because the
 * pump that would deliver it never returns. This is the nested-run-loop
 * behaviour documented in the README, reproduced deliberately.
 */
function click(win: any, view: any, at?: { x: number; y: number }) {
  postMouse(win, view, EventType.LeftMouseDown, at);
  postMouse(win, view, EventType.LeftMouseUp, at);
  settle(16);
}

/** A point in a view's own coordinates, converted to its window's space. */
function inWindow(view: any, at?: { x: number; y: number }): { x: number; y: number } {
  const b = view.bounds();
  const local = at ?? { x: b.width / 2, y: b.height / 2 };
  const p = view.convertPoint_toView_(local, null);
  return { x: p.x, y: p.y };
}

function postMouse(win: any, view: any, type: number, at?: { x: number; y: number }) {
  const loc = inWindow(view, at);
  const e = objc.NSEvent.mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
    type, loc, 0, objc.NSProcessInfo.processInfo().systemUptime(),
    win.windowNumber(), null, 0, 1, type === EventType.LeftMouseDown ? 1.0 : 0.0,
  );
  objc.NSApplication.sharedApplication().postEvent_atStart_(e, false);
}

function postKey(win: any, chars: string, keyCode: number, type: number) {
  const e = objc.NSEvent.keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode_(
    type, { x: 0, y: 0 }, 0, objc.NSProcessInfo.processInfo().systemUptime(),
    win.windowNumber(), null, chars, chars, false, keyCode,
  );
  objc.NSApplication.sharedApplication().postEvent_atStart_(e, false);
}

// ---------------------------------------------------------------------------
// 1. A real click on a real button
// ---------------------------------------------------------------------------
{
  let clicks = 0;
  const button = new Button({ title: "Press me", onClick: () => clicks++ });
  const win = new Window({
    title: "input",
    size: { width: 360, height: 220 },
    content: new VStack({ padding: 24 }, [button]),
    show: true,
  });
  settle(20);

  click(win.native, button.native);
  check("a posted mouse click reached the JS handler", clicks === 1, clicks);
  win.close();
}

// ---------------------------------------------------------------------------
// 2. Typing into a text field
// ---------------------------------------------------------------------------
{
  const changes: string[] = [];
  let submits = 0;
  const field = new TextField({
    placeholder: "type here",
    width: 220,
    onChange: (v) => changes.push(v),
    onSubmit: () => submits++,
  });
  const win = new Window({
    title: "typing",
    size: { width: 360, height: 200 },
    content: new VStack({ padding: 24 }, [field]),
    show: true,
  });
  settle(20);

  field.focus();
  settle(6);
  check("the field became first responder", win.native.firstResponder() !== null);

  // Key codes: h=4, i=34.
  for (const [ch, code] of [["h", 4], ["i", 34]] as Array<[string, number]>) {
    postKey(win.native, ch, code, EventType.KeyDown);
    settle(4);
    postKey(win.native, ch, code, EventType.KeyUp);
    settle(4);
  }

  check("typed characters landed in the field", field.value === "hi", JSON.stringify(field.value));
  check("onChange fired per keystroke", changes.length >= 2, changes);

  // Return key (code 36) commits the field.
  postKey(win.native, "\r", 36, EventType.KeyDown);
  settle(8);
  postKey(win.native, "\r", 36, EventType.KeyUp);
  settle(8);
  check("Return fired onSubmit", submits >= 1, submits);
  win.close();
}

// ---------------------------------------------------------------------------
// 3. Clicking a checkbox toggles it and notifies JS
// ---------------------------------------------------------------------------
{
  const seen: boolean[] = [];
  const box = new Checkbox({ title: "Enabled", checked: false, onChange: (c) => seen.push(c) });
  const win = new Window({
    title: "checkbox",
    size: { width: 320, height: 160 },
    content: new VStack({ padding: 24 }, [box]),
    show: true,
  });
  settle(20);

  // A vertical stack stretches its rows to full width, so the checkbox's frame
  // is far wider than the box-and-label it actually draws. Aim at the box.
  const b = box.native.bounds();
  click(win.native, box.native, { x: 10, y: b.height / 2 });
  check("checkbox toggled on click", box.checked === true, box.checked);
  check("checkbox reported the new state", seen.length === 1 && seen[0] === true, seen);
  win.close();
}

// ---------------------------------------------------------------------------
// 4. Selecting a table row calls back with the right object
// ---------------------------------------------------------------------------
{
  const picked: any[] = [];
  const rows = [
    { name: "first", n: 1 },
    { name: "second", n: 2 },
    { name: "third", n: 3 },
  ];
  const clicked: [number, any][] = [];
  const table = new Table({
    columns: [{ id: "name", title: "Name" }, { id: "n", title: "N", width: 50 }],
    rows,
    onSelect: (row, i) => picked.push([i, row]),
    onClick: (row, i) => clicked.push([i, row]),
    grow: 1,
  });
  const win = new Window({
    title: "table input",
    size: { width: 420, height: 260 },
    content: new VStack({ padding: 12 }, [table]),
    show: true,
  });
  settle(20);

  // Click the middle row through the table view's own hit geometry.
  const rowRect = table.tableView.rectOfRow_(1);
  const p = table.tableView.convertPoint_toView_(
    { x: rowRect.x + 20, y: rowRect.y + rowRect.height / 2 }, null,
  );
  const mk = (type: number) =>
    objc.NSEvent.mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
      type, p, 0, objc.NSProcessInfo.processInfo().systemUptime(),
      win.native.windowNumber(), null, 0, 1, type === EventType.LeftMouseDown ? 1.0 : 0.0,
    );
  const app = objc.NSApplication.sharedApplication();
  app.postEvent_atStart_(mk(EventType.LeftMouseDown), false);
  app.postEvent_atStart_(mk(EventType.LeftMouseUp), false);
  settle(16);

  check("clicking a row selected it", table.selectedIndex === 1, table.selectedIndex);
  check("onSelect got the right row object", picked.some(([i, r]) => i === 1 && r?.name === "second"),
    JSON.stringify(picked));
  // A second click on the row already selected: no selection change, so no onSelect — but a
  // row that does something must hear it again.
  const selects = picked.length;
  app.postEvent_atStart_(mk(EventType.LeftMouseDown), false);
  app.postEvent_atStart_(mk(EventType.LeftMouseUp), false);
  settle(16);
  check("onClick hears every click, the second on the same row too", clicked.length === 2 && clicked.every(([i, r]) => i === 1 && r?.name === "second"), clicked.length);
  check("while onSelect hears only the change", picked.length === selects, picked.length);
  win.close();
}

// ---------------------------------------------------------------------------
// 5. Menu key equivalents
// ---------------------------------------------------------------------------
{
  const { standardMenu } = await import("../src/ui/menu.ts");
  let fired = 0;
  standardMenu({
    appName: "InputTest",
    file: [{ title: "Do Thing", shortcut: "cmd+d", onClick: () => fired++ }],
  });
  const win = new Window({ title: "menu", size: { width: 300, height: 150 }, show: true });
  settle(20);

  const e = objc.NSEvent.keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode_(
    EventType.KeyDown, { x: 0, y: 0 }, Number(C.NSEventModifierFlagCommand),
    objc.NSProcessInfo.processInfo().systemUptime(), win.native.windowNumber(), null,
    "d", "d", false, 2,
  );
  const handled = objc.NSApplication.sharedApplication().mainMenu().performKeyEquivalent_(e);
  settle(10);
  check("cmd+D was routed by the menu", handled === true, handled);
  check("the menu item's JS handler ran", fired === 1, fired);
  win.close();
}

// ---------------------------------------------------------------------------
// A scene under a control: whose press is it?
// ---------------------------------------------------------------------------
{
  // The scene fills its container; a button sits on top of it, as a toolbar or a sidebar
  // sits over content that runs under the glass.
  const scene = new Container({ background: "#203040" });
  const area = new Container();
  area.fill(scene);
  let clicks = 0;
  const button = new Button({ title: "Front", onClick: () => clicks++ });
  // The button is not the scene's: it is in the window's root, on top of the scene's area.
  const root = new Container();
  root.fill(area);
  root.add(button);
  button.native.setFrameOrigin_({ x: 20, y: 20 });
  const win = new Window({ title: "over", size: { width: 420, height: 260 }, content: root, show: true });
  settle(20);
  const keys = input().track(scene, area);

  // The button tracks the mouse itself until the release, and the release never reaches the
  // monitor — so the press used to stay down for good.
  click(win.native, button.native);
  check("the button was clicked", clicks === 1, clicks);
  check("a press that began on a control over the scene is not the scene's", !keys.mouse.pressedOver);
  postMouse(win.native, scene.native, EventType.MouseMoved, { x: 300, y: 200 });
  settle(6);
  check("the next move lets go of a release a control swallowed", !keys.button(0));
  check("and the pointer is over the scene now", keys.mouse.over && keys.mouse.inside);

  postMouse(win.native, scene.native, EventType.LeftMouseDown, { x: 300, y: 200 });
  settle(6);
  check("a press on the scene is the scene's", keys.button(0) && keys.mouse.pressedOver);
  postMouse(win.native, scene.native, EventType.LeftMouseUp, { x: 300, y: 200 });
  settle(6);
  check("and lets go", !keys.button(0) && !keys.mouse.pressedOver);

  // Geometry says the button is inside the scene's rectangle; hit-testing says it is in front.
  postMouse(win.native, button.native, EventType.MouseMoved);
  settle(6);
  check("over a control the pointer is inside the scene but not over it", keys.mouse.inside && !keys.mouse.over);
  win.close();
}

// ---------------------------------------------------------------------------
// Any view can take a click
// ---------------------------------------------------------------------------
{
  let clicked = 0;
  const card = new Container({ background: "#304050" });
  card.onClick(() => clicked++);
  const win = new Window({ title: "click a view", size: { width: 300, height: 200 }, content: card, show: true });
  settle(20);
  click(win.native, card.native);
  check("a click on a plain view with onClick reached it", clicked === 1, clicked);
  win.close();
}

// ---------------------------------------------------------------------------
// Presses counted, and nothing left held by another application
// ---------------------------------------------------------------------------
{
  const scene = new Container({ background: "#203040" });
  const win = new Window({ title: "presses", size: { width: 300, height: 200 }, content: scene, show: true });
  settle(20);
  const keys = input().track(scene);

  // A tap: press and release between two polls. `button()` never reads it; the count does.
  const before = keys.presses(0);
  postMouse(win.native, scene.native, EventType.LeftMouseDown);
  postMouse(win.native, scene.native, EventType.LeftMouseUp);
  settle(6);
  check("a tap is counted though the button was never seen held", keys.presses(0) === before + 1 && !keys.button(0));
  check("and it says whether it began over the view", keys.mouse.lastPressOver);

  // ⌘ went down, and its release happened while another application had the keyboard.
  postKey(win.native, "x", 7, EventType.KeyDown);
  const cmd = objc.NSEvent.keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode_(
    EventType.KeyDown, { x: 0, y: 0 }, Number(C.NSEventModifierFlagCommand), objc.NSProcessInfo.processInfo().systemUptime(),
    win.native.windowNumber(), null, "y", "y", false, 16,
  );
  objc.NSApplication.sharedApplication().postEvent_atStart_(cmd, false);
  settle(6);
  check("a key pressed with ⌘ holds ⌘", keys.command);
  postKey(win.native, "z", 6, EventType.KeyDown);
  settle(6);
  check("the next key without ⌘ lets ⌘ go — the event's own flags say what is held", !keys.command);

  // W held at the moment the application went inactive.
  postKey(win.native, "w", 13, EventType.KeyDown);
  settle(6);
  check("w is held", keys.held("w"));
  objc.NSNotificationCenter.defaultCenter().postNotificationName_object_("NSApplicationDidResignActiveNotification", objc.NSApplication.sharedApplication());
  settle(6);
  check("going inactive lets every key go", !keys.held("w") && !keys.held("x") && keys.keys.size === 0);
  win.close();
}

console.log(failures === 0 ? "\nALL INPUT TESTS PASSED" : `\n${failures} INPUT FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
