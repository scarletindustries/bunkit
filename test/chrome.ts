// Window chrome for macOS 26 — symbols, toolbar, split layout, glass, popover — built in a
// real window and checked. No snapshot: `snapshotWindow` caches the view hierarchy, which
// draws neither the toolbar nor Liquid Glass. `screencapture -l <window number>` does.

import {
  Button,
  Container,
  GlassView,
  Label,
  Popover,
  ScrollView,
  SplitLayout,
  SymbolView,
  Table,
  Toolbar,
  VStack,
  Window,
  symbol,
} from "../src/ui/index.ts";
import { pumpOnce } from "../src/runtime.ts";
import { objc } from "../src/objc.ts";

let failures = 0;

function check(name: string, cond: any, extra?: any) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

function pump(n = 30) {
  for (let i = 0; i < n; i++) pumpOnce(0.002);
}

console.log("symbols");
check("a symbol that exists is an image", symbol("play.fill") !== null);
check("one that does not is null, not a throw", symbol("no.such.symbol.anywhere") === null);
check("a sized symbol is an image", symbol("play.fill", { size: 20, weight: "bold" }) !== null);
const sv = new SymbolView("checkmark.circle.fill", { color: "green" });
check("a symbol view holds its image", sv.native.image() !== null);

console.log("toolbar");
const clicks: string[] = [];
const status = new Label({ text: "Now playing" });
const toolbar = new Toolbar({
  id: "bunkit.test.chrome",
  items: [
    "toggleSidebar",
    "sidebarSeparator",
    {
      kind: "group",
      id: "transport",
      label: "Transport",
      selection: "momentary",
      segments: [
        { symbol: "backward.end.fill", label: "Rewind" },
        { symbol: "play.fill", label: "Play" },
        { symbol: "stop.fill", label: "Stop" },
      ],
      onSelect: (i) => clicks.push(`transport:${i}`),
    },
    "flexibleSpace",
    { kind: "view", id: "now", label: "Now Playing", view: status },
    "flexibleSpace",
    {
      kind: "group",
      id: "switches",
      label: "Switches",
      selection: "any",
      segments: [
        { symbol: "humidity", label: "Haze" },
        { symbol: "move.3d", label: "Mover Motion" },
      ],
      onSelect: (i, sel) => clicks.push(`switches:${i}:${sel.join(",")}`),
    },
    { kind: "button", id: "live", label: "Live", title: "Live", onClick: () => clicks.push("live") },
    "inspectorSeparator",
    "toggleInspector",
  ],
  centered: ["now"],
});

const sidebar = new VStack({ padding: 12 }, [new Label({ text: "Set" })]);
const content = new Container({ background: "#101018" });
const inspector = new VStack({ padding: 12 }, [new Label({ text: "Inspector" })]);
const strip = new Label({ text: "the strip" });
const split = new SplitLayout({
  sidebar: { view: sidebar, min: 220, max: 300 },
  content,
  inspector: { view: inspector, min: 300, max: 300 },
  contentAccessory: strip,
});
const win = new Window({
  title: "Chrome",
  subtitle: "Following the stage Mac",
  toolbarStyle: "unified",
  appearance: "dark",
  fullSizeContent: true,
  size: { width: 1200, height: 700 },
});
toolbar.attach(win);
split.attach(win);
pump();

check("the toolbar is the window's", win.native.toolbar()?.ptr === toolbar.native.ptr);
check("every item made it in", Number(toolbar.native.items().count()) === 10, Number(toolbar.native.items().count()));
check("the subtitle is set", win.subtitle === "Following the stage Mac");
win.subtitle = "Standby";
check("and can change", win.subtitle === "Standby");
check("a status view is not bordered", !toolbar.item("now").native.isBordered());

const live = toolbar.item("live");
live.prominent = true;
live.tint = "red";
check("prominent", Number(live.native.style()) === 1);
live.prominent = false;
check("and back", Number(live.native.style()) === 0);
live.badge = 3;
check("a count badge", live.native.badge() !== null);
live.badge = null;
check("no badge", live.native.badge() === null);
live.click();
check("click fires a button", clicks.includes("live"));

const switches = toolbar.item("switches");
switches.click(0);
check("a toggle turns on", switches.selected[0] === true && switches.selected[1] === false, switches.selected);
switches.click(0);
check("and off", switches.selected[0] === false);
switches.select(1, true);
check("select sets one segment", switches.selected[1] === true);
toolbar.item("transport").setSegment(1, { symbol: "pause.fill", label: "Pause" });
check("a segment can change its label", toolbar.item("transport").spec.kind === "group" && (toolbar.item("transport").spec as any).segments[1].label === "Pause");
let threw = false;
try {
  toolbar.item("nope");
} catch {
  threw = true;
}
check("an unknown item throws", threw);

console.log("split layout");
const frame = (v: any) => v.native.frame();
const winWidth = Number(win.native.contentView().frame().width);
const contentFrame = frame(split.contentHost);
const inspectorWidth = Number(frame(split.inspectorHost!).width);
check("the inspector is its width", Math.abs(inspectorWidth - 300) < 1, inspectorWidth);
const safe = split.contentHost.native.safeAreaInsets();
check(
  "the content runs under the inspector and keeps it out of its safe area",
  Number(safe.right) >= 299 || Number(contentFrame.width) + 300 <= winWidth + 1,
  { safe, contentFrame, winWidth },
);
check("the strip is the content's accessory", Number(split.contentItem.topAlignedAccessoryViewControllers().count()) === 1);
split.contentAccessory = undefined;
pump();
check("and goes", Number(split.contentItem.topAlignedAccessoryViewControllers().count()) === 0);
split.contentAccessory = strip;
const other = new Container({ background: "#203020" });
split.setContent(other);
pump();
check("content swaps", split.content === other && other.native.superview()?.ptr === split.contentHost.native.ptr);
split.setContent(content);
split.inspectorCollapsed = true;
pump(60);
check("the inspector collapses", split.inspectorCollapsed);
split.inspectorCollapsed = false;
pump(60);
check("and comes back", !split.inspectorCollapsed);

console.log("content beside the panes");
const beside = new SplitLayout({ content: new Container(), inspector: { view: new Label({ text: "i" }), min: 300, max: 300 }, contentUnderPanes: false });
const win2 = new Window({ title: "Beside", fullSizeContent: true, toolbarStyle: "unified", size: { width: 1000, height: 500 } });
beside.attach(win2);
pump();
const besideWidth = Number(beside.contentHost.native.frame().width);
const win2Width = Number(win2.native.contentView().frame().width);
check("content that frames its own centre sits beside the inspector", Math.abs(besideWidth - (win2Width - 300)) < 2, { besideWidth, win2Width });
check("and the side panes keep to their safe area", Number(beside.inspectorHost!.native.safeAreaInsets().top) >= 0);
win2.close();

console.log("scroll documents");
const scroller = new ScrollView({ height: 100 }, new VStack({}, [new Label({ text: "top" })]));
check("a scroll view's document is flipped, so its top is zero", Boolean(scroller.native.documentView().isFlipped()));
check("and it does not inset itself for a toolbar", !scroller.native.automaticallyAdjustsContentInsets());

console.log("glass and buttons");
const glassButton = new Button({ title: "Load", glass: true, prominence: "primary", tint: "blue", shape: "capsule" });
check("glass bezel", Number(glassButton.native.bezelStyle()) === 16);
check("primary tint", Number(glassButton.native.tintProminence()) === 2);
const card = new GlassView(new VStack({ spacing: 4 }, [new Label({ text: "Standby" }), glassButton]), { radius: 22, padding: 18 });
content.add(card);
const cx = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(card.native, 9, 0, content.native, 9, 1, 0);
const cy = objc.NSLayoutConstraint.constraintWithItem_attribute_relatedBy_toItem_attribute_multiplier_constant_(card.native, 10, 0, content.native, 10, 1, 0);
cx.setActive_(true);
cy.setActive_(true);
pump();
const cardFrame = frame(card);
check("the glass wraps its content with its padding", Number(cardFrame.width) > 60 && Number(cardFrame.height) > 50, cardFrame);

console.log("popover");
const popover = new Popover({ content: new VStack({ padding: 16 }, [new Label({ text: "Brightness" })]) });
popover.showFrom(card, "bottom");
pump();
check("shown", popover.shown);
popover.close();
pump(60);
check("closed", !popover.shown);

console.log("table: group rows and heights");
type Row = { header?: boolean; name: string };
const rows: Row[] = [{ header: true, name: "Set" }, { name: "Simona" }, { name: "Fire" }];
const table = new Table<Row>({
  columns: [{ id: "name", title: "Name" }],
  rows,
  style: "SourceList",
  headers: false,
  isGroup: (r) => r.header === true,
  heightOf: (r, i) => (i === 2 ? 48 : 28),
});
sidebar.add(table);
pump();
const delegate = table.tableView.delegate();
check("a header row is a group row", Boolean(delegate.tableView_isGroupRow_(table.tableView, 0)));
check("and cannot be selected", !delegate.tableView_shouldSelectRow_(table.tableView, 0));
check("a song can", Boolean(delegate.tableView_shouldSelectRow_(table.tableView, 1)));
check("rows take their own heights", Math.abs(Number(table.tableView.rectOfRow_(2).height) - 48) < 1, table.tableView.rectOfRow_(2));

win.close();
if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("chrome: all ok");
process.exit(0);
