<img width="128" src="https://github.com/scarletindustries.png" />

### BunKit

Real AppKit apps for macOS, written in TypeScript on Bun.

[Documentation](https://scarlet.industries/docs/bunkit)

---

![the demo app](docs/demo.png)

bunkit builds mac apps out of real appkit windows, tables, menus and sheets, with all of the app logic in typescript. there's no webview anywhere, so the table in that screenshot is a real `NSTableView`.

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

### try it

you'll need macos on apple silicon, [bun](https://bun.sh) 1.4 or newer, and the xcode command line tools (`xcode-select --install`).

```shell
git clone https://github.com/scarletindustries/bunkit
cd bunkit
bun install
./native/build.sh
bun run hello
```

`bun run tour` covers most of the api on one screen and `bun run demo` is the screenshot above. `scene`, `rig`, `playground` and `particles` are the metal examples. to turn one into an `.app`:

```shell
bun run bundle examples/demo.ts --name "My App" --id com.example.myapp --icon icon.png
open "dist/My App.app"
```

### how it works

the objective-c runtime will hand you the full type signature of any method, so one bridge reads that and calls `objc_msgSend` through libffi instead of there being a wrapper per method. three layers sit on top of it:

| | | |
|---|---|---|
| `src/ui/` | layer 3 | `Window`, `VStack`, `Button`, `Table`, 26 classes |
| `src/objc.ts` | layer 2 | `objc.NSWindow.alloc().init…()`, marshalling, delegates, blocks |
| `src/bridge.ts` | layer 1 | dlopen, packing arguments into buffers |

every layer 3 object has a `.native` for when you need to drop to layer 2, which reaches all of appkit. [the bridge](https://scarlet.industries/docs/bunkit/bridge) and [metal](https://scarlet.industries/docs/bunkit/metal) docs cover the rest.

### 3d

![a metal scene](docs/scene3d.png)

`Scene3D` is a view like any other, so it drops into a stack next to the labels and buttons.

```ts
const scene = new Scene3D({ grow: 1, camera: { position: [4, 2.6, 5] } });

scene.add(plane({ size: 40, color: "#20202a" }));
const cube = scene.add(box({ size: 1.1, position: [0, 0.55, 0], color: "#aa091b" }));

scene.onFrame(({ dt }) => { cube.rotation.y += dt; });
```

### the annoying parts

appkit runs its own nested run loop for modal dialogs, menu tracking, live resize and drags, and js is frozen the whole time it's in there. so the dialogs are sheets that hand you a promise, and menu tracking and live resize pause the app until someone lets go of the mouse.

pointers are `bigint`, not `number`, so compare against `0n`.

### where it's at

it works and it's tested, but it only ad-hoc signs, there's no npm package yet, and swiftui hosting is missing.

```shell
bun test
bun run typecheck
```

### contributing

run `./native/build.sh && bun run typecheck && bun test` before you open a pr, and read `CLAUDE.md` for the conventions. for anything substantial, ask on discord (@hiett) first so we're not doing the same work twice.

bunkit is not affiliated with bun or with oven. it's named after the only runtime it runs on.

### license

[Apache License 2.0](LICENSE). see [NOTICE](NOTICE) for the attribution notices.
