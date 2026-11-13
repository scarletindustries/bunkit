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

`--icon` takes a 1024×1024 `.png`, a ready `.icns`, or an icon composer `.icon`, which xcode 26's `actool` compiles into the `Assets.car` macOS 26 draws as liquid glass (with an `.icns` beside it for older systems).

a worker the app starts with `spawnThread(new URL("./name.ts", import.meta.url))` (or a plain `new Worker` with the same url) has to be compiled in too, or it loads from source and fails in the app: pass it with `--worker src/name.ts` (or `workers` in a config). it lands at the root of the bundled file system under its own file name, which is where that url points in the binary.

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

macos 26 draws its own liquid glass, and every piece of it is reachable from here. `Toolbar` builds an `NSToolbar` from a list (buttons, groups of toggles or pickers, any view, and appkit's own spaces and tracking separators) and hands back a handle per item, so a button can turn prominent and red while it is live or carry a badge. `SplitLayout` is an `NSSplitViewController` with a floating sidebar, the content, and an inspector; the content runs under the toolbar and the inspector, and a strip can be pinned to its top. `GlassView` puts one view on liquid glass (`passive: true` for a card that only says something — clicks go through it to whatever is under), `Popover` opens one next to a toolbar item, and `symbol()` / `SymbolView` are sf symbols (a `SymbolView` keeps its size and weight when its symbol changes). `VideoView` plays a muted clip behind other views through avfoundation — looped by `AVPlayerLooper`, layer-hosting so it follows its view's size, still on its first frame when reduce motion is on, never keeping the display awake, and an empty view rather than a throw when the file isn't there — and `ScrimView` is the gradient that goes over it so the words on top stay readable. put both in a `Container` with `fill`, the controls last. `formSection()` lays out a settings window the way system settings does — titled, rounded groups of rows with a footnote — gives every bit of running text a width to wrap at, and keeps every row's padding above and below its tallest view (`NSStackView` only asks for it, and a label over a two-line note filled its row to the hairline).

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

metalfx is there too, with a fallback built in: `TemporalScaler.create(gpu(), { input, output, ... })` and `SpatialScaler.create(...)` load the framework themselves and hand back `null` where it's missing or won't take the sizes, so you always have somewhere to fall back to. measured on an m2 pro the temporal scaler is 1.2ms from 960×540 to 1600×900 and 4.1ms from 1382×894 to 3456×2234, and building one takes 0.1–0.3s (2.4s the first time in a process) — rebuild it per resolution and you'll feel it. so don't build it on a thread that keeps time: `TemporalScaler.build(...)` builds it on a background queue and hands back a build to poll (`state`, then `take()`), holding the caller under half a millisecond, and `dynamic: [1, 3]` makes one scaler take any render size in that range, so a renderer that moves its resolution keeps the one it has. macOS 26's frame interpolator is there as `FrameInterpolator`, built the same way.

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

it's a `CAMetalLayer` rather than an `MTKView`, so frames come from bunkit's main loop — a display link per screen, so a view draws at the rate of the screen it's on, and keeps drawing through menus and live resize — instead of a second one. `.native` is on every object if you want the raw obj-c, and `scene.capture()` / `scene.snapshot()` read the framebuffer back — which is how all of this is tested, since nobody is watching.

### peer to peer

`bunkit/net` finds other macs nearby and talks to them, on network.framework: over awdl (the link airdrop uses — wi-fi on, no network joined), over a shared wi-fi network, or over an ethernet cable, whichever works. a listener advertises itself with bonjour, a browser finds every listener of a type along with its txt record before connecting, and a connection carries whole messages, in order.

```ts
import { PeerListener, PeerBrowser } from "bunkit/net";

const listener = new PeerListener({ type: "_myapp._tcp", name: "Stage Mac", txt: { v: "1" } });
listener.onConnection((c) => c.onMessage((m) => c.send(m)));   // handed over once ready

const browser = new PeerBrowser({ type: "_myapp._tcp" });
browser.onChange(async (peers) => {
  const c = browser.connect(peers[0]!);
  c.onMessage((m) => console.log(m.byteLength));
  await c.opened();
  await c.send(new Uint8Array(1024));   // resolves when network.framework has taken it
  console.log(c.path);                  // { interface: "awdl0", peerToPeer: true, wired: false, … }
});
```

a message is a 4-byte big-endian length and the bytes, at most 16 MiB, checked by the sender before it sends and by the receiver before it reads. a longer one, a peer that closes halfway through one, or a peer speaking tls to an end that isn't fails the connection with a reason rather than anything worse. every object stays open until either end closes it, like a socket.

`tls: { psk, identity }` on a listener, a browser or a connection turns on tls with a pre-shared key: tls 1.2 with `TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256` and nothing else, so the key authenticates both ends and each connection still gets its own ephemeral secret. a wrong key fails in milliseconds and never reaches `onConnection`; a listener can hold several keys (one per paired peer) and picks by identity. the identity goes over the wire in the clear, so make it opaque. it isn't tls 1.3 because that doesn't work from here: on macOS 26.6 every tls 1.3 configuration with `sec_protocol_options_add_pre_shared_key` fails its handshake (-9858) even with the right key, and offered both versions it settles on 1.2.

none of it runs on the main thread except your handlers. network.framework gets a private serial queue (`native/src/net.m`), where the reading, the framing and the copy into each message all happen; javascript takes whole messages in batches, in a turn of bunkit's main loop — so they keep arriving while a menu is open or a window is being resized — or, in a script that never pumps, from a `threadsafe` bun:ffi callback. a received message isn't copied again: the buffer it was put together in becomes the `Uint8Array`'s memory, freed when that's collected. `send` copies the bytes and returns (0.2 ms for 1 MiB, ~1.5 ms for 16 MiB), and its promise is the backpressure. a receiver that falls behind stops reading at 64 MiB per connection, so tcp's window closes and the sender's sends stop completing, rather than memory growing.

measured on an m2 pro over loopback:

| | |
| --- | --- |
| 1 MiB messages | ~4,000 MiB/s; ~1,600 MiB/s with the main thread busy 8 ms in every 10 |
| 16 MiB messages | ~4,400 MiB/s; ~3,400 MiB/s with the main thread that busy |
| a 1 ms timer's worst gap meanwhile | 1.2–1.8 ms in plain bun; 3–4.6 ms inside the run loop, most of it the pump's own 4 ms wait |
| a small message's round trip | 0.12 ms median, in plain bun and inside the run loop alike |

handing network.framework the main queue instead was measured too, and lost: in a process that doesn't pump nothing moves at all, and with the main thread busy 8 ms in 10 it did 957 MiB/s against 1,544, and 1,368 against 3,527 with 16 MiB messages.

**local network privacy.** on macOS 15 and later, browsing or advertising with bonjour needs the local network permission, which macOS asks for once per app. it belongs to the *responsible* process: run from a terminal that's the terminal (or the ide), not bun, so a terminal that's already been allowed never asks again. a bundled app declares why it wants it and which types it uses, through the bundler's `plist`:

```ts
plist: {
  NSLocalNetworkUsageDescription: "Finds the other Macs in your rig.",
  NSBonjourServices: ["_myapp._tcp"],
},
```

loopback never needs it. `advertise: false` makes a listener without bonjour, reached with `PeerConnection.connect({ host: "127.0.0.1", port })`: measured in a process responsible for itself with no permission, no prompt and nothing in the privacy log. a browser that's been refused reports `"waiting"` with the reason, so an app can say where to go to allow it.

to try awdl between two macs, turn wi-fi on in both but join no network (or be somewhere no network is known), unplug ethernet, and run `bun run tools/peer-check.ts` on each. they find each other on `awdl0`, connect, and print the route, the round trip and the throughput. `--tls <word>` does the same over tls, `--no-p2p` leaves awdl out.

### the main loop

appkit takes the main thread and keeps it until someone lets go of the mouse: an open menu, a live resize, a modal session. bun can't run its event loop from inside a native call, so for as long as appkit holds on, nothing of bun's runs — no `setTimeout`, no i/o, no promise continuations. that used to mean frozen animations and stalled sockets every time a menu opened.

so bunkit has a main loop of its own, on appkit's run loop in its common modes, which keeps running in there:

```ts
import { MainLoop, onFrame } from "bunkit/runtime";

MainLoop.every(100, () => refreshStatus());   // still ticks while a menu is open
onFrame(({ targetTimestamp }) => animate(targetTimestamp));
const chosen = await popUpMenu(items, view);  // opened from the pump, so none of yours is on the stack
```

it only ever runs at a safe point — when the only javascript on the stack is bunkit's own pump — and each run is a whole turn with a microtask checkpoint after every callback, so run-to-completion holds: nothing of the main loop's starts while a function of yours is halfway through. `MainLoop.after`, `every`, `post`, `sleep` and `nextFrame` are deliberately not `setTimeout`, and nothing global is patched. frames come from a display link per screen, so a view draws at the rate of the screen it's on, through live resize too. `MainLoop.stats` says how long the main thread was held, by what, and how late the loop ran, and `MainLoop.onStall` tells you when it happens.

anything that would start a nested loop from your call is opened from the pump instead: `popUpMenu` hands you a promise of the item chosen, and `sendFromPump` (layer 2) does the same for any call. dialogs are sheets — `alert`, `confirm`, `prompt`, `openFile` and `saveFile` all hand you a promise — and hang from a transparent host window when there's no window to hang one on, so `runModal` is never reached. a nested loop you start yourself through layer 2 still works, keeps run-to-completion, and pauses the main loop; bunkit says so, once per call site, with the line it came from. the design and every measurement behind it are in [the main loop spec](docs/main-loop/spec.md).

### threads

work that mustn't stop — a show's clock, a socket someone's waiting on — belongs on a thread, whose bun loop appkit never touches:

```ts
import { spawnThread, cellLayout } from "bunkit/thread";

const show = spawnThread(new URL("./show.ts", import.meta.url), { name: "show" });
show.channel.send({ kind: "load", path });
show.channel.onMessage((m) => status(m));        // arrives during a menu too
const Safety = cellLayout("safety", { live: true, haze: 1 });
const safety = show.cell(Safety, "write");        // the thread reads it every frame
```

the channel is a ring each way in shared memory. a message from a thread signals the main loop's run-loop source, so it's delivered inside menus and resizes, in order, and a busy stream costs one wake-up per turn rather than one per message. strings and typed arrays go as their bytes, anything else as a structured clone, and a big message goes through an arena that grows to fit. a shared cell is a fixed set of numbers with one writer behind a seqlock: no messages, the latest value wins. an uncaught error in a thread comes back with its stack, and threads are ended on quit against one deadline, so a stuck one is abandoned rather than waited for.

### the annoying parts

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

a `msgSend` costs about 230ns, a callback from obj-c into js about 870ns, a main-loop turn about 0.3µs, and idle cpu with a window open sits around 1.3–2%, the same as before the main loop. a sixty second soak of several million calls, main-loop timers, trampolined calls and thread messages holds flat.

still missing: notarization (it only ad-hoc signs), an npm package (the dylib has to be compiled, so that needs prebuilt binaries), and swiftui hosting.

### contributing

issues and prs welcome. run `./native/build.sh && bun run typecheck && bun test` before you open one. `CLAUDE.md` has the conventions and the traps in it.

like carder, a lot of this gets written by claude. if you want to take on something substantial, hit me up on discord (@hiett) first so we're not doing the same work twice.

### the name

bunkit is not affiliated with bun, or with oven, the company behind it. the name is descriptive: bun is the only runtime it runs on. `bun:ffi` is what crosses into the dylib, and bun's event loop is what the pump hands the thread back to between slices, so it won't run under node or deno.

### license

bunkit is licensed under the [Apache License 2.0](LICENSE). you're free to use, modify, and distribute it — including in commercial and closed-source products — provided you keep the license and attribution notices intact. the Apache license also carries an explicit patent grant. see [LICENSE](LICENSE) and [NOTICE](NOTICE) for the full terms.
