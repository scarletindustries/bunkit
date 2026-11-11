// Window chrome for macOS 26 — symbols, toolbar, split layout, glass, popover — built in a
// real window and checked. No snapshot: `snapshotWindow` caches the view hierarchy, which
// draws neither the toolbar nor Liquid Glass. `screencapture -l <window number>` does.

import {
  Button,
  ControlBorderShape,
  Segmented,
  Container,
  GlassView,
  Label,
  Popover,
  ScrollView,
  SearchField,
  SplitLayout,
  SymbolTile,
  SymbolView,
  Table,
  Toolbar,
  VStack,
  Window,
  formNote,
  formSection,
  makeFont,
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
// A changed symbol keeps the size it was made with: it came back at the default, so a column of
// icons changed at runtime came out in two sizes.
const sized = new SymbolView("info.circle", { size: 14, weight: "semibold" });
const madeAt = sized.native.image().size();
sized.name = "exclamationmark.triangle.fill";
sized.name = "info.circle";
const after = sized.native.image().size();
check("a changed symbol keeps its size and weight", Number(after.width) === Number(madeAt.width) && Number(after.height) === Number(madeAt.height), { madeAt, after });

console.log("symbol tiles");
const tile = new SymbolTile("gearshape.fill", { color: "gray" });
const tileFrame = () => {
  tile.native.layoutSubtreeIfNeeded();
  return tile.native.fittingSize();
};
check("a tile is 20 points square, as a sidebar's are", Math.round(Number(tileFrame().width)) === 20 && Math.round(Number(tileFrame().height)) === 20, tileFrame());
check("it holds its symbol", tile.image !== null);
check("drawn white", Boolean(tile.native.subviews().objectAtIndex_(0).contentTintColor().isEqual_(objc.NSColor.whiteColor())));
check("on a rounded square", Number(tile.native.layer().cornerRadius()) === 5);
check("with a gradient of two colours", Number(tile.native.layer().sublayers().objectAtIndex_(0).colors().count()) === 2);
tile.color = "#ff0000";
check("and can be recoloured", Number(tile.native.layer().sublayers().objectAtIndex_(0).colors().count()) === 2);
const missing = new SymbolTile("no.such.symbol.anywhere", { color: "blue", size: 32 });
check("a symbol the system lacks leaves the tile empty, not a throw", missing.image === null);
check("and a tile can be any size", Math.round(Number(missing.native.fittingSize().width)) === 32);

console.log("search fields");
const typed: string[] = [];
const submitted: string[] = [];
const search = new SearchField({ onChange: (v) => typed.push(v), onSubmit: (v) => submitted.push(v) });
check("the placeholder is macOS's own word", String(search.native.placeholderString()) === "Search");
check("it is a real NSSearchField", Boolean(search.native.isKindOfClass_(objc.NSSearchField)));
search.native.setStringValue_("mid");
search.native.delegate().controlTextDidChange_(null);
check("typing is a change", typed.join("|") === "mid", typed);
search.native.delegate().controlTextDidChange_(null);
check("the same text twice is one change", typed.length === 1, typed);
search.native.setStringValue_("");
search.native.sendAction_to_(search.native.action(), search.native.target());
check("the clear button is a change too", typed.join("|") === "mid|", typed);
search.value = "dmx";
check("setting it from code fires nothing", typed.length === 2 && search.value === "dmx");
const handled = search.native.delegate().control_textView_doCommandBySelector_(search.native, null, "insertNewline:");
check("Return is taken, and submits", Boolean(handled) && submitted.join("|") === "dmx", submitted);
check("another command is left to the field", !search.native.delegate().control_textView_doCommandBySelector_(search.native, null, "moveUp:"));

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
    { kind: "button", id: "back", label: "Back", symbol: "chevron.left", navigational: true },
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
  sidebar: { view: sidebar, min: 220, max: 300, collapsible: false },
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
check("every item made it in", Number(toolbar.native.items().count()) === 11, Number(toolbar.native.items().count()));
check("a navigational item says so", Boolean(toolbar.item("back").native.isNavigational()));
check("an ordinary one does not", !toolbar.item("live").native.isNavigational());
check("a sidebar can be made uncollapsible", !split.sidebarItem.canCollapse());
check("an inspector is collapsible unless it says otherwise", Boolean(split.inspectorItem.canCollapse()));
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
// AppKit's validation pass re-enabled a disabled segment a few times a second, and the app's
// next sync disabled it again: a transport that flickered while nothing was loaded.
const transportSegment = toolbar.item("transport").native.subitems().objectAtIndex_(1);
toolbar.item("transport").enableSegment(1, false);
let reEnabled = false;
for (let i = 0; i < 40; i++) {
  pumpOnce(0.01);
  if (Boolean(transportSegment.isEnabled())) reEnabled = true;
}
check("a disabled segment stays disabled — AppKit does not validate it back on", !reEnabled);
toolbar.item("transport").enableSegment(1, true);
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
// Hidden, not removed: putting a large view back into a window is most of what a switch costs.
check("the content it replaced stays in the pane, hidden", content.native.superview()?.ptr === split.contentHost.native.ptr && Boolean(content.native.isHidden()));
split.setContent(content);
check("and switching back shows it again, hiding the other", !Boolean(content.native.isHidden()) && Boolean(other.native.isHidden()));
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
// A passive card says something over a scene; a click on it is a click on what is under it.
const passive = new GlassView(new Label({ text: "Standby" }), { passive: true, padding: 18 });
content.add(passive);
pump();
const middle = passive.native.convertPoint_toView_({ x: Number(passive.native.bounds().width) / 2, y: Number(passive.native.bounds().height) / 2 }, null);
const under = win.native.contentView().hitTest_(middle);
check("a passive glass is never what a click lands on", under !== null && under.ptr !== passive.native.ptr && !Boolean(under.isDescendantOf_(passive.native)));
const solid = card.native.convertPoint_toView_({ x: 4, y: 4 }, null);
const onCard = win.native.contentView().hitTest_(solid);
check("an ordinary one is", onCard !== null && Boolean(onCard.isDescendantOf_(card.native)));
passive.removeFromParent();

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
console.log("forms");
const section = formSection({
  title: "Audio",
  rows: [
    { label: "Output", controls: [new Label({ text: "System default" })], note: "the interface" },
    { controls: [new Label({ text: "a row of controls" })] },
  ],
  footer: "Every wrapping label in a form has a width, so the window is not as wide as the sentence.",
});
const [title, group, footer] = section.children as [Label, VStack, Label];
check("a section is its title, its group and its footer", section.children.length === 3);
check("the title is in title case, as given", title.text === "Audio");
check("rows are separated by a hairline", group.children.length === 3);
check("the footer wraps at a width", Number(footer.native.preferredMaxLayoutWidth()) > 0);
check("a note does too", Number(formNote("x", 300).native.preferredMaxLayoutWidth()) === 300);

const control = new Label({ text: "On" });
const leadingView = new Label({ text: "Rich Helix" });
const settings = formSection({
  controls: "trailing",
  labelWidth: 180,
  rows: [
    { label: "Reload on Save", controls: [control], note: "Rebuild the show when a file is saved." },
    { leading: leadingView, controls: [new Label({ text: "XR18" })] },
  ],
});
const settingsGroup = settings.children[0] as VStack;
const firstRow = settingsGroup.children[0] as VStack;
const [nameColumn, gap, onLabel] = firstRow.children as [VStack, any, Label];
check("a trailing row puts its label first", (nameColumn.children[0] as Label).text === "Reload on Save");
check("its note goes under the label", (nameColumn.children[1] as Label).text === "Rebuild the show when a file is saved.");
check("and wraps at the label column", Number((nameColumn.children[1] as Label).native.preferredMaxLayoutWidth()) === 180);
check("then the slack, then the controls at the trailing edge", gap.constructor.name === "Spacer" && onLabel === control);
const secondRow = settingsGroup.children[2] as VStack;
check("a leading view takes the label's place", secondRow.children[0] === leadingView);
const leadingColumns = formSection({ rows: [{ leading: leadingView, controls: [] }] });
check("in a column layout too", ((leadingColumns.children[0] as VStack).children[0] as VStack).children[0] === leadingView);
check("fixed-width digits are a font", makeFont({ size: 11, digits: true }) !== null);

// A segmented control's outline: a capsule, to sit inside a glass capsule (macOS 26).
const capsule = new Segmented({ items: ["Fast", "Fancy"], shape: "capsule" });
const plain = new Segmented({ items: ["Fast", "Fancy"] });
if (capsule.native.respondsTo("borderShape")) {
  check("shape: capsule draws a capsule", Number(capsule.native.borderShape()) === ControlBorderShape.Capsule);
  check("and without it the control keeps AppKit's automatic shape", Number(plain.native.borderShape()) === ControlBorderShape.Automatic);
} else {
  check("before macOS 26 the shape is ignored, not a throw", capsule.selectedIndex === 0);
}

if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("chrome: all ok");
process.exit(0);
