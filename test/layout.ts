// Layout harness — renders a set of layouts, dumps their view trees, and
// asserts the geometry. Run with BUNKIT_SHOTS=<dir> to also write PNGs.

import {
  Button,
  Container,
  Checkbox,
  GroupBox,
  HStack,
  Label,
  Progress,
  Segmented,
  Select,
  Separator,
  Slider,
  Spacer,
  Switch,
  Table,
  TextArea,
  TextField,
  VStack,
  View,
  Window,
  checkLayout,
  describeViewTree,
  snapshotWindow,
} from "../src/ui/index.ts";
import { pumpOnce } from "../src/runtime.ts";
import { constants as C } from "../src/ui/appkit.ts";
import { str } from "../src/objc.ts";

const SHOTS = process.env.BUNKIT_SHOTS;
let failures = 0;

function check(name: string, cond: any, extra?: any) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

function settle(w: Window, n = 12) {
  // Auto Layout resolves on the next display pass, so give AppKit a few turns.
  w.native.layoutIfNeeded();
  for (let i = 0; i < n; i++) pumpOnce(0.004);
  w.native.contentView().layoutSubtreeIfNeeded();
}

function show(name: string, w: Window, root: View) {
  settle(w);
  if (SHOTS) {
    try {
      snapshotWindow(w, `${SHOTS}/${name}.png`);
    } catch (e: any) {
      console.log(`  (snapshot failed: ${e.message})`);
    }
  }
  if (process.env.BUNKIT_TREE) console.log(describeViewTree(root));
}

const W = 800;
const H = 500;

// ---------------------------------------------------------------------------
// 1. A vertical stack should fill the window's width
// ---------------------------------------------------------------------------
{
  const a = new Label({ text: "top" });
  const b = new Label({ text: "bottom" });
  const stack = new VStack({ spacing: 10, padding: 20 }, [a, b, new Spacer()]);
  const w = new Window({ title: "vstack", size: { width: W, height: H }, content: stack, show: false });
  show("01-vstack", w, stack);
  check("vstack fills width", stack.frame.width === W, stack.frame.width);
  check("vstack fills height", stack.frame.height === H, stack.frame.height);
  check("child inside padding", Math.abs(a.alignmentRect.x - 20) < 0.5, a.alignmentRect.x);
  check(
    "child stretches to padded width",
    Math.abs(a.alignmentRect.width - (W - 40)) < 1,
    a.alignmentRect.width,
  );
  w.close();
}

// ---------------------------------------------------------------------------
// 2. A horizontal stack should share width and fill height
// ---------------------------------------------------------------------------
{
  const leftLabel = new Label({ text: "L" });
  const left = new GroupBox({ title: "left", padding: 10 }, [leftLabel]);
  const right = new GroupBox({ title: "right", padding: 10 }, [new Label({ text: "R" })]);
  const row = new HStack({ spacing: 12 }, [left, right]);
  const stack = new VStack({ spacing: 10, padding: 16 }, [row]);
  const w = new Window({ title: "hstack", size: { width: W, height: H }, content: stack, show: false });
  show("02-hstack", w, stack);

  check("row fills width", Math.abs(row.frame.width - (W - 32)) < 1, row.frame.width);
  check("left starts at 0 within the row", left.frame.x === 0, left.frame.x);
  check(
    "right is inside the row",
    right.frame.x + right.frame.width <= row.frame.width + 0.5,
    `${right.frame.x} + ${right.frame.width} vs ${row.frame.width}`,
  );
  check("boxes do not overlap", left.frame.x + left.frame.width <= right.frame.x + 0.5,
    `${left.frame.x + left.frame.width} vs ${right.frame.x}`);
  check("left box has content", left.contentStack.frame.width > 0, left.contentStack.frame.width);
  check(
    "group box padding is applied to its children",
    Math.abs(leftLabel.alignmentRect.x - 10) < 0.5,
    leftLabel.alignmentRect.x,
  );
  check(
    "group box title sits above the body",
    !!left.titleLabel && left.titleLabel!.frame.y > left.contentStack.frame.y,
    `${left.titleLabel?.frame.y} vs ${left.contentStack.frame.y}`,
  );
  w.close();
}

// ---------------------------------------------------------------------------
// 3. Fixed-width children keep their width; spacer absorbs the rest
// ---------------------------------------------------------------------------
{
  const label = new Label({ text: "Name", width: 60 });
  const field = new TextField({ placeholder: "value", grow: 1 });
  const btn = new Button({ title: "Go" });
  const row = new HStack({ spacing: 8, align: "center" }, [label, field, btn]);
  const stack = new VStack({ spacing: 10, padding: 16 }, [row, new Spacer()]);
  const w = new Window({ title: "form", size: { width: W, height: H }, content: stack, show: false });
  show("03-form", w, stack);

  check("fixed label width honoured", Math.abs(label.alignmentRect.width - 60) < 0.5, label.alignmentRect.width);
  // AppKit's own default for a label is to clip mid-letter; a squeezed label says "…" instead.
  check("a label truncates with an ellipsis, not a clip", Number(label.native.lineBreakMode()) === Number(C.NSLineBreakByTruncatingTail), Number(label.native.lineBreakMode()));
  check("and a middle-truncating one in the middle", Number(new Label({ text: "x", truncate: "middle" }).native.lineBreakMode()) === Number(C.NSLineBreakByTruncatingMiddle));
  check("field grew", field.frame.width > 300, field.frame.width);
  check("button kept intrinsic width", btn.frame.width > 20 && btn.frame.width < 120, btn.frame.width);
  check(
    "row items are in order",
    label.frame.x < field.frame.x && field.frame.x < btn.frame.x,
    `${label.frame.x} ${field.frame.x} ${btn.frame.x}`,
  );
  w.close();
}

// ---------------------------------------------------------------------------
// 4. Table sizing and column widths
// ---------------------------------------------------------------------------
{
  const table = new Table({
    columns: [
      { id: "a", title: "A", width: 200 },
      { id: "b", title: "B", width: 120 },
      { id: "c", title: "C", width: 80, align: "right" },
    ],
    rows: [
      { a: "one", b: "uno", c: 1 },
      { a: "two", b: "dos", c: 2 },
    ],
    grow: 1,
  });
  const stack = new VStack({ spacing: 10, padding: 16 }, [table]);
  const w = new Window({ title: "table", size: { width: W, height: H }, content: stack, show: false });
  show("04-table", w, stack);

  const cols = table.tableView.tableColumns();
  const widths = [0, 1, 2].map((i) => Number(cols.objectAtIndex_(i).width()));
  check("explicit column widths preserved", widths[0] === 200 && widths[1] === 120, widths);
  check("last column absorbed the slack", widths[2]! > 80, widths);
  check("table fills the stack", Math.abs(table.frame.width - (W - 32)) < 1, table.frame.width);
  check("table has rows", Number(table.tableView.numberOfRows()) === 2, table.tableView.numberOfRows());
  w.close();
}

// ---------------------------------------------------------------------------
// 4b. New rows on a text table are drawn in place: the same cells, new text
// ---------------------------------------------------------------------------
{
  type Row = { a: string; n: number };
  const table = new Table<Row>({
    columns: [
      { id: "a", title: "A", width: 160 },
      { id: "n", title: "N", width: 80, value: (r) => `#${r.n}` },
    ],
    rows: [
      { a: "one", n: 1 },
      { a: "two", n: 2 },
      { a: "three", n: 3 },
    ],
    grow: 1,
  });
  const stack = new VStack({ spacing: 10, padding: 16 }, [table]);
  const w = new Window({ title: "table rows", size: { width: W, height: H }, content: stack, show: true });
  settle(w);

  const tv = table.tableView;
  const cell = (col: number, row: number) => tv.viewAtColumn_row_makeIfNecessary_(col, row, false);
  const text = (col: number, row: number) => String(cell(col, row)?.textField().stringValue() ?? "");
  const before = cell(0, 1);
  check("a text table fills its cells", text(0, 1) === "two" && text(1, 2) === "#3", `${text(0, 1)} ${text(1, 2)}`);

  table.select(1);
  table.rows = [
    { a: "one", n: 1 },
    { a: "TWO", n: 2 },
    { a: "three", n: 30 },
  ];
  settle(w, 4);
  check("changed text is drawn", text(0, 1) === "TWO" && text(1, 2) === "#30", `${text(0, 1)} ${text(1, 2)}`);
  check("…into the same cell, not a rebuilt one", cell(0, 1)?.ptr === before?.ptr);
  check("…and the selection is kept", table.selectedIndex === 1, table.selectedIndex);

  table.rows = [...table.rows, { a: "four", n: 4 }, { a: "five", n: 5 }];
  settle(w, 4);
  check("more rows are added", Number(tv.numberOfRows()) === 5 && text(0, 4) === "five",
    `${tv.numberOfRows()} ${text(0, 4)}`);
  table.rows = [{ a: "only", n: 9 }];
  settle(w, 4);
  check("fewer rows are removed", Number(tv.numberOfRows()) === 1 && text(0, 0) === "only",
    `${tv.numberOfRows()} ${text(0, 0)}`);
  check("the visible rows are the ones on screen", table.visibleRows.first === 0 && table.visibleRows.count === 1,
    JSON.stringify(table.visibleRows));

  // A caller that mutates the array it handed over and hands it back is still drawn.
  const rows = table.rows;
  rows.push({ a: "pushed", n: 10 });
  table.rows = rows;
  settle(w, 4);
  check("a mutated array handed back is drawn", Number(tv.numberOfRows()) === 2 && text(1, 1) === "#10",
    `${tv.numberOfRows()} ${text(1, 1)}`);
  w.close();
}

// ---------------------------------------------------------------------------
// 4c. Setting what is already there is free, and setting something new still lands
// ---------------------------------------------------------------------------
{
  const label = new Label({ text: "one" });
  const button = new Button({ title: "Play" });
  const w = new Window({ title: "setters", size: { width: 300, height: 120 },
    content: new VStack({ padding: 8 }, [label, button]), show: false });
  label.text = "one";
  label.text = "two";
  label.text = "two";
  check("a label shows the last text set", label.text === "two", label.text);
  button.title = "Pause";
  button.title = "Pause";
  check("a button shows the last title set", button.title === "Pause", button.title);
  label.hidden = true;
  label.hidden = true;
  check("hidden takes", label.hidden === true);
  label.hidden = false;
  check("and comes back", label.hidden === false);
  w.close();
}

// ---------------------------------------------------------------------------
// 5. The full demo layout, in miniature
// ---------------------------------------------------------------------------
{
  const nameField = new TextField({ placeholder: "Name", width: 200 });
  const detail = new GroupBox({ title: "Details", padding: 12 }, [
    new HStack({ spacing: 8, align: "center" }, [new Label({ text: "Name", width: 52 }), nameField]),
    new HStack({ spacing: 8, align: "center" }, [
      new Label({ text: "Score", width: 52 }),
      new Slider({ min: 0, max: 100, value: 50, width: 180 }),
      new Label({ text: "50", width: 34, align: "right" }),
    ]),
  ]);
  const showcase = new GroupBox({ title: "Controls", padding: 12 }, [
    new HStack({ spacing: 10, align: "center" }, [
      new Checkbox({ title: "Check", checked: true }),
      new Switch({ on: true }),
      new Select({ items: ["A", "B"], width: 90 }),
    ]),
    new HStack({ spacing: 10, align: "center" }, [
      new Progress({ max: 100, value: 40, width: 140 }),
      new Spacer(),
      new Button({ title: "Go" }),
    ]),
  ]);
  const row = new HStack({ spacing: 12, align: "fill" }, [detail, showcase]);
  const log = new TextArea({ value: "log line\n", editable: false, height: 80 });
  const stack = new VStack({ spacing: 12, padding: 16 }, [
    new HStack({ spacing: 8, align: "center" }, [
      new Label({ text: "Header", font: { style: "title" } }),
      new Spacer(),
      new Button({ title: "Add" }),
    ]),
    new Separator(),
    row,
    log,
  ]);
  const w = new Window({ title: "composite", size: { width: 900, height: 520 }, content: stack, show: false });
  show("05-composite", w, stack);

  const inside = (v: View) =>
    v.frame.x >= -0.5 && v.frame.x + v.frame.width <= (v.parent?.frame.width ?? 1e9) + 0.5;

  check("detail inside its row", inside(detail), `${detail.frame.x}+${detail.frame.width} in ${row.frame.width}`);
  check("showcase inside its row", inside(showcase), `${showcase.frame.x}+${showcase.frame.width} in ${row.frame.width}`);
  check(
    "detail and showcase do not overlap",
    detail.frame.x + detail.frame.width <= showcase.frame.x + 0.5,
    `${detail.frame.x + detail.frame.width} vs ${showcase.frame.x}`,
  );
  check("row within window", row.frame.width <= 900 - 32 + 0.5, row.frame.width);
  check("log is visible", log.frame.height >= 60, log.frame.height);
  check("nothing has zero size", stack.children.every((c) => c.frame.width > 0 && c.frame.height > 0),
    stack.children.map((c) => `${c.frame.width}x${c.frame.height}`).join(" "));

  // Vertical stacking: arranged subviews must not overlap and must stay inside
  // the stack. AppKit's y axis grows upward, so later children have smaller y.
  const kids = [...stack.children];
  let ok = true;
  for (let i = 1; i < kids.length; i++) {
    const above = kids[i - 1]!, below = kids[i]!;
    if (below.frame.y + below.frame.height > above.frame.y + 0.5) ok = false;
  }
  check("vstack children do not overlap", ok,
    kids.map((c) => `y=${c.frame.y.toFixed(0)}+${c.frame.height.toFixed(0)}`).join(" "));
  check("all children inside the stack",
    kids.every((c) => c.frame.y >= -0.5 && c.frame.y + c.frame.height <= stack.frame.height + 0.5),
    kids.map((c) => `${c.frame.y.toFixed(0)}..${(c.frame.y + c.frame.height).toFixed(0)}`).join(" "));
  check("group boxes have real height", detail.frame.height > 60 && showcase.frame.height > 60,
    `${detail.frame.height} ${showcase.frame.height}`);
  check("detail content is inside the group box",
    detail.contentStack.frame.height > 0 && detail.contentStack.frame.height <= detail.frame.height,
    `${detail.contentStack.frame.height} vs ${detail.frame.height}`);
  check("log did not swallow the window", log.frame.height < 200, log.frame.height);
  w.close();
}

// ---------------------------------------------------------------------------
// 6. Nothing spills out of its container, at any window width
//
// This is the regression guard for the bug where a row of fixed-width controls
// inside a group box drew straight over the box border once the window was
// narrowed: Auto Layout broke the weakest constraint and the overflow was
// silent.
// ---------------------------------------------------------------------------
{
  for (const width of [900, 828, 760, 720]) {
    const slider = new Slider({ min: 0, max: 100, value: 50, width: 220 });
    const scoreRow = new HStack({ spacing: 8, align: "center" }, [
      new Label({ text: "Score", width: 52 }),
      slider,
      new Label({ text: "50", width: 34, align: "right" }),
    ]);
    const detail = new GroupBox({ title: "Details", padding: 12 }, [
      new HStack({ spacing: 8, align: "center" }, [
        new Label({ text: "Name", width: 52 }),
        new TextField({ placeholder: "Name", width: 220 }),
      ]),
      scoreRow,
    ]);
    const controls = new GroupBox({ title: "Controls", padding: 12 }, [
      new HStack({ spacing: 10, align: "center" }, [
        new Checkbox({ title: "Checkbox", checked: true }),
        new Switch({ on: true }),
        new Select({ items: ["Alpha"], width: 110 }),
        new Segmented({ items: ["List", "Grid", "Cards"] }),
      ]),
      new HStack({ spacing: 10, align: "center" }, [
        new Progress({ max: 100, value: 40, width: 180 }),
        new Spacer(),
        new Button({ title: "Ask…" }),
      ]),
    ]);
    const stack = new VStack({ spacing: 12, padding: 16 }, [
      new HStack({ spacing: 12, align: "fill" }, [detail, controls]),
    ]);
    const w = new Window({ title: `spill-${width}`, size: { width, height: 420 }, content: stack, show: false });
    settle(w);

    const inner = detail.contentStack.frame;
    const row = scoreRow.frame;
    const left = row.x;
    const right = inner.width - (row.x + row.width);
    check(
      `@${width}pt the score row keeps its padding`,
      left >= 11.5 && right >= 11.5,
      `padding ${left.toFixed(1)}/${right.toFixed(1)}, want 12/12`,
    );

    const violations = checkLayout(w);
    check(`@${width}pt nothing draws outside its parent`, violations.length === 0,
      violations.slice(0, 3).map((v) => `${v.view} in ${v.parent}: ${v.detail}`).join("; "));
    w.close();
  }

  // A detector that cannot fire is worth nothing, so make it fire: a Required
  // width larger than its container is exactly the shape of the original bug.
  {
    const oversized = new Label({ text: "far too wide" });
    oversized.constrain("width", "==", 600);           // Required, unlike ViewOptions
    const box = new Container({ width: 200, height: 60 });
    box.add(oversized);
    const w = new Window({ title: "spill-probe", size: { width: 300, height: 160 },
      content: new VStack({ padding: 8 }, [box]), show: false });
    settle(w);
    const found = checkLayout(w);
    check("checkLayout detects a real overflow", found.length > 0,
      found.map((v) => v.detail).join("; ") || "detector never fires — it is vacuous");
    w.close();
  }
}

// ---------------------------------------------------------------------------
// A dropdown draws the item that is selected — its own copy of it
// ---------------------------------------------------------------------------
{
  const choices: string[] = [];
  const sel = new Select({ items: ["One", "Two", "Three"], selected: 2, onChange: (_i, t) => choices.push(t) });
  check("a dropdown shows the item it was built selected on", str(sel.native.title()) === "Three", str(sel.native.title()));
  sel.selectedIndex = 0;
  check("and the one it is set to", str(sel.native.title()) === "One", str(sel.native.title()));
  sel.items = ["X", "Y"];
  check("and new items show the first", str(sel.native.title()) === "X", str(sel.native.title()));
  // A person's choice: AppKit selects the item, then sends the action.
  sel.native.selectItemAtIndex_(1);
  sel.native.sendAction_to_(sel.native.action(), sel.native.target());
  check("a choice is drawn, and told", str(sel.native.title()) === "Y" && choices.at(-1) === "Y", { title: str(sel.native.title()), choices });
}

console.log(failures === 0 ? "\nALL LAYOUT TESTS PASSED" : `\n${failures} LAYOUT FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
