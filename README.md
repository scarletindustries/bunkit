<img width="128" src="https://github.com/scarletindustries.png" />

### BunKit

Real AppKit apps for macOS, written in TypeScript on Bun.

[Documentation](https://scarlet.industries/docs/bunkit)

---

![the demo app](docs/demo.png)

bunkit builds mac apps out of actual appkit — windows, tables, menus, sheets — with all of the app logic sitting in typescript. there's no webview anywhere, so the screenshot above is a real `NSTableView` with real `NSTextField`s in it.

```ts
import { Application, Window, VStack, HStack, Label, Button, TextField } from "bunkit";

const app = new Application({ name: "Hello" });

const name = new TextField({ placeholder: "Your name", grow: 1 });
const greeting = new Label({ text: "…" });

new Window({
  title: "Hello",
  size: { width: 360, height: 180 },
  content: new VStack({ spacing: 12, padding: 20 }, [
    new HStack({ spacing: 8 }, [
      name,
      new Button({ title: "Greet", primary: true, onClick: () => {
        greeting.text = `Hello, ${name.value}!`;
      }}),
    ]),
    greeting,
  ]),
}).quitOnClose();

await app.run();
```

### why?

i wanted to know if you could write a proper mac app without shipping a browser to draw it. turns out you can, and it's a lot less work than you'd think, because the objective-c runtime hands you everything you need to call it at runtime. this is also just fun.

### let me try it

you'll need macos on apple silicon, [bun](https://bun.sh) 1.4 or newer, and the xcode command line tools (`xcode-select --install`).

```shell
git clone https://github.com/scarletindustries/bunkit
cd bunkit
bun install
./native/build.sh
```

`bun run hello` is about twenty lines. `bun run tour` is a task list that covers most of the api on one screen. `bun run demo` is the screenshot up top, and `bun run scene` is the 3d one.

to turn something into an actual `.app`:

```shell
bun run bundle examples/demo.ts --name "My App" --id com.example.myapp --icon icon.png
open "dist/My App.app"
```

a worker the app starts with `new Worker(new URL("./name.ts", import.meta.url))` has to be compiled in too, or it loads from source and fails in the app: pass it with `--worker src/name.ts` (or `workers` in a config). it lands at the root of the bundled file system under its own file name, which is where that url points in the binary.

### how?

ask the objective-c runtime about any method and it'll give you the whole signature back:

```c
method_getTypeEncoding(class_getInstanceMethod(objc_lookUpClass("NSWindow"),
                       sel_registerName("initWithContentRect:styleMask:backing:defer:")))
// -> "@68@0:8{CGRect={CGPoint=dd}{CGSize=dd}}16Q48Q56B64"
```

argument types, return type, struct layouts, all of it, with no headers to parse. so rather than writing a c wrapper per appkit method (and there are tens of thousands of them) there's one bridge that reads that encoding, builds an `ffi_cif` and calls `objc_msgSend` through libffi. it's around 1300 lines and it doesn't need to change when you want a class it's never heard of.

three layers sit on top:

| | | |
|---|---|---|
| `src/ui/` | layer 3 | `Window`, `VStack`, `Button`, `Table`, `Toolbar`, `SplitLayout`, `formSection`, 32 classes |
| `src/objc.ts` | layer 2 | `objc.NSWindow.alloc().init…()`, marshalling, delegates, blocks |
| `src/bridge.ts` | layer 1 | dlopen, packing arguments into buffers |

layer 3 is the pleasant one. when it doesn't cover what you need you drop to layer 2, which reaches all of appkit — every layer 3 wrapper has a `.native` on it for exactly that.

it goes through libffi instead of using `bun:ffi` on its own because `bun:ffi` wants the signature up front at dlopen time. it can't build one at runtime, can't pass a struct by value, and can't make a function pointer with an arbitrary signature. all three of those are needed here.

the encoding reader, the dispatcher, the closure trampolines, the memory model and the pump are all written up in [the bridge](https://scarlet.industries/docs/bunkit/bridge).

### window chrome

macos 26 draws its own liquid glass, and every piece of it is reachable from here. `Toolbar` builds an `NSToolbar` from a list (buttons, groups of toggles or pickers, any view, and appkit's own spaces and tracking separators) and hands back a handle per item, so a button can turn prominent and red while it is live or carry a badge. `SplitLayout` is an `NSSplitViewController` with a floating sidebar, the content, and an inspector; the content runs under the toolbar and the inspector, and a strip can be pinned to its top. `GlassView` puts one view on liquid glass (`passive: true` for a card that only says something — clicks go through it to whatever is under), `Popover` opens one next to a toolbar item, and `symbol()` / `SymbolView` are sf symbols. `formSection()` lays out a settings window the way system settings does — titled, rounded groups of rows with a footnote — and gives every bit of running text a width to wrap at.

a `Select` draws its own copy of the selected item rather than the menu's — a window of eight 16-item dropdowns laid out in 87 ms the other way, 28 ms this one. any view takes a click with `view.onClick(fn)` (a click gesture recogniser), and a `Table` has `onClick` beside `onSelect` — every click, the row already selected included, never an arrow key — for a row that *does* something. a table with a rendered column reloads only the rows that changed (compared field by field), so put everything a row draws in the row. `SplitLayout.setContent` hides the content it replaces rather than removing it: putting a big view back into a window is most of what a switch costs. a sheet with no window given hangs from a visible one, never a closed window that something still holds.

toolbar items don't autovalidate: enabled is whatever you last set. left on, appkit's validation pass re-enables a disabled segment a few times a second and your next sync disables it again — a button that flickers. and a `Label` that's too narrow truncates with an ellipsis (`truncate: "middle"` or `"head"` to move it), where appkit's own default for a label is to clip mid-letter.

```ts
const toolbar = new Toolbar({
  id: "main",
  items: [
    "toggleSidebar", "sidebarSeparator",
    { kind: "group", id: "transport", label: "Transport", selection: "momentary",
      segments: [{ symbol: "play.fill", label: "Play" }, { symbol: "stop.fill", label: "Stop" }] },
    "flexibleSpace",
    { kind: "button", id: "live", label: "Live", title: "Live", onClick: goLive },
    "inspectorSeparator", "toggleInspector",
  ],
});
const split = new SplitLayout({ sidebar: { view: list }, content: scene, inspector: { view: details } });
const win = new Window({ title: "Show", toolbarStyle: "unified", fullSizeContent: true });
toolbar.attach(win);
split.attach(win);
toolbar.item("live").prominent = true;
```

### 3d

there's a metal renderer in the box. `Scene3D` is a view like any other, so it drops into a stack next to the labels and buttons.

![a metal scene](docs/scene3d.png)

```ts
const scene = new Scene3D({ grow: 1, camera: { position: [4, 2.6, 5] } });

scene.add(plane({ size: 40, color: "#20202a" }));
const cube = scene.add(box({ size: 1.1, position: [0, 0.55, 0], color: "#aa091b" }));

scene.onFrame(({ dt }) => { cube.rotation.y += dt; });
```

`box`, `sphere`, `plane`, `cylinder` and `cone`, or your own vertex data through `geometry()`. nodes that share a shape and a material get batched into one instanced draw, so the draw call count follows the number of distinct meshes rather than the number of objects. two hundred cubes is one draw.

a frame isn't on screen when you draw it. on a 120 Hz macbook panel it gets there 24–32 ms later. `scene.stats.present` says how long, measured from each drawable's own `presentedTime`, and `screenLatencyMs(stats.present)` is the number to add to *now* when you're deciding what to draw — anything synced to music should draw what'll be true when the picture is seen, not when it was drawn.

a view that animates asks `view.frameDue` before drawing. `nextDrawable` blocks until the display frees a drawable, and a view drawn whenever the run loop comes round spends a third of the main thread in there, so a native thread does that waiting instead: it keeps one drawable ready and wakes the run loop when it has. `frameDue` is true when one is. the view's own loop (`animate`) already does this.

a material that never reads the normal — anything flat or unlit — should say `normals: false`. a non-uniformly scaled node otherwise pays for an inverse-transpose every frame for nothing: on a 2d diagram of a few thousand quads that was 40% of encoding a frame.

`bun run scene` is that example.

### shaders

the layer under `Scene3D` is a typed gpu api. it borrows [typegpu](https://github.com/software-mansion/TypeGPU)'s idea — declare a struct once, generate both the byte layout and the msl from it — and adds the other direction, because metal's compiler will tell you the layout it decided on.

so you can start from the schema:

```ts
const Globals = struct("Globals", { viewProjection: mat4x4f, time: f32 });

const pipeline = gpu().renderPipeline({
  shader: msl`
    ${Globals}
    vertex float4 vs(constant Globals &g [[buffer(0)]]) { ... }
    fragment float4 fs() { ... }
  `,
});
```

or skip it entirely and let the compiler describe the struct you already wrote:

```ts
pass.pipeline(pipeline).bind({
  g: { viewProjection, time: 0.4 },   // packed using metal's own offsets
  albedo: texture,                     // right stage, right index
});
```

`bind` takes the names out of the shader. there are no buffer indices to keep in sync on this side, and renumbering `[[buffer(2)]]` can't quietly break the caller — a name that doesn't exist throws and lists the ones that do.

entry points get found the same way. one vertex function and one fragment function in the library means you don't name either.

a full-screen effect is a string:

```ts
const invert = gpu().effect(`return float4(1.0 - src.sample(smp, uv).rgb, 1.0);`);

frame.effect(invert, { to: screen, bind: { src: sceneTexture } });
```

`src`, `smp` and `uv` are in scope, the sampler gets bound for you, and the triangle gets drawn for you. pass a whole `fragment` function instead when one expression isn't enough — it's an ordinary pipeline underneath, so `bind` still finds whatever you declared.

a live editor is then a text view and a debounce. `bun run playground` is one — type msl on the left, watch it on the right, with compile errors shown under the offending line and the last shader that worked still rendering while you fix the one that doesn't.

![the shader playground](docs/playground.png)

compute is the same shape. `gpu().kernel(source)` finds the entry point, `kernel.run(n, bindings)` dispatches it, and `frame.dispatch(...)` puts it in the same command buffer as the drawing so the simulation and the draw that reads it are ordered by the gpu instead of a cpu wait.

`bun run particles` is a quarter of a million of them, simulated in a kernel and drawn as point sprites. per frame javascript writes two uniform structs — 128 bytes — and issues a dispatch, a draw and the bloom chain: 0.5ms of js against 3.2ms of gpu at 2000×1384. the particle count doesn't appear in the frame callback at all, so a million costs the gpu and not the loop.

textures come in the shapes a renderer reaches for: `type: "3d"` for a volume (a fog field, a lookup table), `"2dArray"` for a stack of shadow maps, mip chains filled on the gpu with `frame.mipmaps(texture)`, and `texture.view({ level, slice })` to write one level or render into one layer. a sampler takes `compare: "lessEqual"` for hardware pcf through `depth2d::sample_compare`, and `pass.dispatchThreads(w, h, d)` runs one thread per pixel or voxel with no bounds check in the kernel. `Scene3D.renderer` hands a frame's camera matrices to a function of your own instead of drawing the nodes, so one view can have two renderers and switch between them.

metalfx is there too, with a fallback built in: `TemporalScaler.create(gpu(), { input, output, ... })` and `SpatialScaler.create(...)` load the framework themselves and hand back `null` where it's missing or won't take the sizes, so you always have somewhere to fall back to. measured on an m2 pro the temporal scaler is 1.2ms from 960×540 to 1600×900 and 4.1ms from 1382×894 to 3456×2234, and building one takes 0.1–0.3s (2.4s the first time in a process) — rebuild it per resolution and you'll feel it.

compiling can happen off the main thread. metal caches what it compiles, keyed by the source and by the code it makes, so a shader it has seen is a fraction of a millisecond — but the first run after one changes is the whole compiler, 140–550ms for a big library and up to ~360ms for a pipeline state, on whichever thread asked. `await gpu().shaderAsync(source)` compiles on metal's threads and resolves to the same `Shader` the cache hands out from then on. for code that can be tried again, `gpu().nonBlocking(() => build())` makes every library and pipeline state the build asks for that metal hasn't got start compiling in the background and throw `CompilePending` (`isCompilePending(e)`); poll `gpu().compiling` until it's 0 and build again, now from the cache. what metal has cached comes back inside a 2ms grace and isn't put off, a library compiled in the background starts its kernels' pipeline states compiling too (they depend on nothing else, and are as new to metal as it is), `gpu().deferred` counts what was (so a build that caught one and carried on can be told), and at most two compiles run at once — the compiler takes every core it's given, and twenty at once left the main thread without one for 20–60ms at a time.

`src/metal/shaders.ts` has the msl you'd otherwise retype: aces, colour temperature in kelvin, ordered dither, value noise and fbm, sdfs, cone falloff. they're snippets — interpolate one and its dependencies come with it, deduplicated.

### a rig

![a stage lighting rig](docs/lighting-rig.png)

twenty-four moving heads, each with a yoke, a head, a volumetric beam and a pool on the floor, re-aimed from javascript every frame. hdr into a bloom chain and an aces tone map, msaa, 220 nodes, **9 draw calls**, and 0.6ms of javascript per frame at 2160×1424 — the aiming maths for twenty-four moving heads included.

the draw call count doesn't follow the object count, and that's the whole trick. measured on an m2 pro, a draw call with its bindings costs about 1.2µs from js. transforming a node and writing its instance struct costs 0.12µs. so:

| nodes | draw calls | js per frame |
| --- | --- | --- |
| 220 (the rig) | 9 | 0.61 ms |
| 20,000 cubes | 1 | 2.3 ms |
| 100,000 cubes | 1 | 8.2 ms |

twenty thousand animated objects fit in a frame with room to spare. the same objects drawn one at a time would be 25ms of encoding before any of them moved. adding another hundred fixtures to the rig adds no draw calls at all.

frames are paced to the display rather than run free. presenting faster than the refresh changes nothing you can see, `nextDrawable` blocks on vsync anyway, and decoupling just presents staler state — which for anything synced to music is worse than a lower frame rate. the view keeps at most two command buffers outstanding and skips a tick when the gpu hasn't caught up, so the run loop never blocks.

completion is polled rather than handled. metal calls `addCompletedHandler:` on its own thread and a js callback entered from there deadlocks bun, so the status gets read at the top of the next tick from the thread that's allowed to read it.

hold the right mouse button to look around and fly with wasd. input is polled rather than delivered — `keys.held("w")` asked once per frame, inside the frame callback, which is what a loop wants and what a callback API makes awkward:

```ts
const keys = view.input;

scene.onFrame(({ dt }) => {
  if (keys.held("w")) move(forward, speed * dt);
  if (keys.pressed("space")) jump();          // true on exactly one frame
  yaw -= keys.mouse.dx * 0.005;               // zero on a frame with no motion
});
```

it's one application-wide `NSEvent` monitor rather than an `NSView` subclass, so it sees every key regardless of which control has focus, and it passes every event straight through — nothing else in the app notices. key codes map by position, so wasd stays under the same fingers on an azerty keyboard.

the mouse is hit-tested, because content that runs under glass is under it: `mouse.inside` is geometry, but `mouse.over` says the pointer is on the view with nothing in front of it (what appkit would deliver the click to) and `mouse.pressedOver` says the held press *began* there — so a drag that starts on a sidebar and wanders over the scene is still the sidebar's. orbit on `pressedOver`, zoom on `over`. give the view's container as `view.inputArea` if the scene has overlays of its own. a control runs its own tracking loop and the release never reaches the monitor, so a button also counts as released on the next mouse move — without that, every click on a control left the button "held". `presses(0)` counts presses, so a tap that went down and up between two polls is still seen (`mouse.lastPressOver` says where it began). everything held is let go when the app stops being active, and modifiers are read from each key's own event — a release in another app never reaches the monitor.

content under a sidebar or a toolbar also wants its camera centred on what's visible. set `scene.camera.insets` (points, from the view's safe area) and the projection is fitted to the uncovered rectangle — fov spans the visible height, the visible centre is where it looks, and the picture carries on under the glass. `insetPerspective()` is the matrix, for anything else that projects (labels pinned to points in the scene).

`bun run rig` is the example.

it's a `CAMetalLayer` rather than an `MTKView`, so frames come from bunkit's run loop instead of a second one. `.native` is on every object if you want the raw obj-c, and `scene.capture()` / `scene.snapshot()` read the framebuffer back — which is how all of this is tested, since nobody is watching.

### the annoying parts

appkit runs its own nested run loop for modal dialogs, menu tracking, live resize and drags, and js is frozen the whole time it's in there. dialogs were the worst of it, so layer 3 gives you sheets instead: `alert`, `confirm`, `prompt`, `openFile` and `saveFile` all hand you a promise and the pump keeps ticking underneath. `alert` and `prompt` fall back to a blocking modal when there's no window to hang a sheet on, which is the only place `runModal` gets reached. menu tracking and live resize you just live with. they're bounded by someone letting go of the mouse.

`table.rows = …` updates the table in place when every column is text: rows get added or removed at the end, and only the cells whose text changed are touched. a full `reloadData` rebuilds every visible cell through the js datasource, and on a few dozen rows refreshed ten times a second that was a 35 ms stall on the main thread every tenth pass. a table with a `render` column still reloads, and `table.reload()` is there if you want the rebuild. `table.visibleRows` says which rows are on screen, for rows that cost something to work out.

setting a `Label`'s `text`, a `Button`'s `title` or any view's `hidden` to what it already is does nothing. appkit marks things for layout on every set, changed or not, and readouts refreshed twenty times a second add up.

pointers are `bigint`, not `number`. apple packs short strings and small numbers into the pointer itself, which pushes the value past 2^53. compare against `0n`.

arm64 only. struct returns there go through plain `objc_msgSend` with x8 holding the result pointer, so the whole `objc_msgSend_stret` family doesn't exist in the dispatcher. the build script and the bundler both refuse an intel target rather than build you something that returns structs wrong.

enum values come out of a generator rather than out of my head. `NSTextAlignment` on arm64 uses the ios ordering (left, center, right) and not appkit's older one (left, right, center), which i typed in by hand and then spent a while wondering why everything i right-aligned was centred. `tools/gen-constants.ts` recovers 5521 of them by compiling a probe against the sdk, and `tools/gen-types.ts` walks the live runtime for the classes and protocols so layer 2 autocompletes.

### where it's at

it works, and there's a decent amount of test coverage — marshalling, layout geometry, synthetic mouse and keyboard events, run loop behaviour, and a soak test for leaks.

```shell
bun test
bun run typecheck
```

a `msgSend` costs about 230ns, a callback from obj-c into js about 870ns, and idle cpu with a window open sits around 1.3%. a sixty second soak of several million calls holds flat.

still missing: notarization (it only ad-hoc signs), an npm package (the dylib has to be compiled, so that needs prebuilt binaries), and swiftui hosting.

### contributing

issues and prs welcome. run `./native/build.sh && bun run typecheck && bun test` before you open one. `CLAUDE.md` has the conventions and the traps in it.

like carder, a lot of this gets written by claude. if you want to take on something substantial, hit me up on discord (@hiett) first so we're not doing the same work twice.

### the name

bunkit is not affiliated with bun, or with oven, the company behind it. the name is descriptive: bun is the only runtime it runs on. `bun:ffi` is what crosses into the dylib, and bun's event loop is what the pump hands the thread back to between slices, so it won't run under node or deno.

### license

bunkit is licensed under the [Apache License 2.0](LICENSE). you're free to use, modify, and distribute it — including in commercial and closed-source products — provided you keep the license and attribution notices intact. the Apache license also carries an explicit patent grant. see [LICENSE](LICENSE) and [NOTICE](NOTICE) for the full terms.
