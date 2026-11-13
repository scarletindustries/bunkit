// A real AppKit app, entirely in TypeScript. No WebView anywhere.
//
//   bun run examples/demo.ts

import {
  alert,
  Application,
  Button,
  Checkbox,
  confirm,
  GroupBox,
  HStack,
  Label,
  MainLoop,
  Progress,
  ScrollView,
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
  Window,
  openFile,
  prompt,
} from "bunkit";

interface Person {
  name: string;
  role: string;
  score: number;
}

const people: Person[] = [
  { name: "Ada Lovelace", role: "Analyst", score: 98 },
  { name: "Alan Turing", role: "Cryptanalyst", score: 97 },
  { name: "Grace Hopper", role: "Rear Admiral", score: 96 },
  { name: "Katherine Johnson", role: "Mathematician", score: 99 },
  { name: "Margaret Hamilton", role: "Engineer", score: 95 },
];

const app = new Application({
  name: "BunKit Demo",
  // Shutdown work belongs here: the process ends when run() returns.
  onQuit: () => console.log("clean exit"),
  menu: {
    file: [
      { title: "Open…", shortcut: "cmd+o", onClick: onOpen },
      { separator: true, title: "" },
      { title: "Add Person", shortcut: "cmd+n", onClick: onAddPerson },
    ],
    preferences: () => alert({ title: "Settings", message: "Nothing to configure yet." }),
  },
});

// --- left pane: the list ----------------------------------------------------

const table = new Table<Person>({
  columns: [
    { id: "name", title: "Name", width: 170 },
    { id: "role", title: "Role", width: 140 },
    { id: "score", title: "Score", width: 60, align: "right" },
  ],
  rows: people,
  rowHeight: 26,
  onSelect: (row) => showDetail(row),
  minHeight: 200,
  grow: 2,
});

// --- right pane: the detail form -------------------------------------------

const nameField = new TextField({ placeholder: "Name", grow: 1 });
const roleField = new TextField({ placeholder: "Role", grow: 1 });
const scoreSlider = new Slider({ min: 0, max: 100, value: 50, grow: 1 });
const scoreLabel = new Label({ text: "50", width: 34, align: "right" });
scoreSlider.onChange((v) => {
  scoreLabel.text = String(Math.round(v));
});

const detail = new GroupBox({ title: "Details", padding: 12 }, [
  new HStack({ spacing: 8, align: "center" }, [
    new Label({ text: "Name", width: 52 }),
    nameField,
  ]),
  new HStack({ spacing: 8, align: "center" }, [
    new Label({ text: "Role", width: 52 }),
    roleField,
  ]),
  new HStack({ spacing: 8, align: "center" }, [
    new Label({ text: "Score", width: 52 }),
    scoreSlider,
    scoreLabel,
  ]),
  new HStack({ spacing: 8 }, [
    new Spacer(),
    new Button({ title: "Apply", primary: true, onClick: applyDetail }),
    new Button({
      title: "Delete",
      destructive: true,
      onClick: async () => {
        const i = table.selectedIndex;
        if (i < 0) return;
        const who = table.rows[i]!.name;
        if (await confirm("Delete this person?", who, { destructive: true, window: win })) {
          table.removeAt(i);
          log(`deleted ${who}`);
        }
      },
    }),
  ]),
]);

function showDetail(row: Person | null) {
  nameField.value = row?.name ?? "";
  roleField.value = row?.role ?? "";
  scoreSlider.value = row?.score ?? 0;
  scoreLabel.text = String(Math.round(row?.score ?? 0));
}

function applyDetail() {
  const i = table.selectedIndex;
  if (i < 0) return;
  table.rows[i] = {
    name: nameField.value,
    role: roleField.value,
    score: Math.round(scoreSlider.value),
  };
  table.reload();
  table.select(i);
  log(`updated row ${i}`);
}

// --- controls showcase ------------------------------------------------------

const progress = new Progress({ max: 100, value: 0, width: 180 });
const spinner = new Progress({ spinner: true, width: 18, height: 18 });
const modeSwitch = new Switch({
  on: true,
  onChange: (on) => log(`switch -> ${on ? "on" : "off"}`),
});

const showcase = new GroupBox({ title: "Controls", padding: 12 }, [
  new HStack({ spacing: 10, align: "center" }, [
    new Checkbox({ title: "Checkbox", checked: true, onChange: (c) => log(`checkbox ${c}`) }),
    modeSwitch,
    new Select({
      items: ["Alpha", "Beta", "Gamma"],
      onChange: (i, t) => log(`select ${i} (${t})`),
      width: 110,
    }),
    new Segmented({
      items: ["List", "Grid", "Cards"],
      onChange: (i) => log(`segment ${i}`),
    }),
  ]),
  new HStack({ spacing: 10, align: "center" }, [
    progress,
    spinner,
    new Spacer(),
    new Button({ title: "Ask…", onClick: onAskName }),
    new Button({ title: "Open…", symbol: "folder", onClick: onOpen }),
  ]),
]);

// --- log pane ---------------------------------------------------------------

const logView = new TextArea({
  value: "",
  editable: false,
  font: { monospace: true, size: 11 },
  height: 110,
});

function log(msg: string) {
  const t = new Date().toLocaleTimeString();
  logView.value = `${logView.value}[${t}] ${msg}\n`;
  logView.textView.scrollRangeToVisible_({ location: logView.value.length, length: 0 });
}

// --- window -----------------------------------------------------------------

const clock = new Label({
  text: "",
  font: { monospace: true, size: 11 },
  color: "secondaryLabel",
});

const win = new Window({
  title: "BunKit — native AppKit from Bun",
  size: { width: 900, height: 640 },
  minSize: { width: 720, height: 520 },
  content: new VStack({ spacing: 12, padding: 16 }, [
    new HStack({ spacing: 8, align: "center" }, [
      new Label({ text: "People", font: { style: "title", weight: "semibold" } }),
      new Spacer(),
      clock,
      new Button({ title: "Add", symbol: "plus", onClick: onAddPerson }),
    ]),
    table,
    new Separator(),
    new HStack({ spacing: 12, align: "fill" }, [detail, showcase]),
    new Label({ text: "Event log", font: { size: 11, weight: "semibold" }, color: "secondaryLabel" }),
    logView,
  ]),
});
win.quitOnClose();

// --- behaviour --------------------------------------------------------------

async function onAddPerson() {
  const name = await prompt("Add a person", { placeholder: "Full name", window: win });
  if (!name) return;
  table.append({ name, role: "New", score: 50 });
  table.select(table.rows.length - 1);
  log(`added ${name}`);
}

async function onOpen() {
  const files = await openFile({ multiple: true, window: win, title: "Pick any file" });
  log(files.length ? `opened ${files.join(", ")}` : "open cancelled");
}

async function onAskName() {
  const r = await alert({
    title: "How is it going?",
    message: "This sheet does not block the JavaScript event loop — watch the clock keep ticking.",
    buttons: ["Great", "Fine", "Not now"],
    window: win,
    suppressible: true,
  });
  log(`alert -> ${r.title}${r.suppressed ? " (suppressed)" : ""}`);
}

// UI refreshes on BunKit's main loop rather than setInterval: these keep ticking while a menu is
// open, a window is being resized or a slider is being dragged, where Bun's own timers stop.
MainLoop.every(1000, () => {
  clock.text = new Date().toLocaleTimeString();
});

let p = 0;
MainLoop.every(120, () => {
  p = (p + 3) % 101;
  progress.value = p;
});

table.select(0);
showDetail(people[0]!);

log("ready — everything you see is a real NSView");

fetch("https://example.com")
  .then((r) => log(`fetch(example.com) -> HTTP ${r.status} while the UI stayed live`))
  .catch((e) => log(`fetch failed: ${e.message}`));

await app.run();
