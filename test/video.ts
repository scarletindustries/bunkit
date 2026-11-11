// VideoView: a muted clip through AVFoundation, behind other views. Built in a real window
// with a one-second clip (`fixtures/clip.mp4`, 64 px, 4 KB) and checked against the player.

import { join } from "node:path";
import { Container, Label, ScrimView, VideoView, Window, avFoundationAvailable, reduceMotion } from "../src/ui/index.ts";
import { pumpOnce } from "../src/runtime.ts";
import { objc, str } from "../src/objc.ts";

let failures = 0;

function check(name: string, cond: any, extra?: any) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/** Pump the run loop until `ok`, or `ms` pass. */
async function until(ok: () => boolean, ms = 4000): Promise<boolean> {
  const end = performance.now() + ms;
  while (!ok() && performance.now() < end) {
    pumpOnce(0.01);
    await Bun.sleep(5);
  }
  return ok();
}

objc.NSApplication.sharedApplication();
const clip = join(import.meta.dir, "fixtures", "clip.mp4");

console.log("availability");
check("AVFoundation loads, and has the player classes", avFoundationAvailable());
check("reduce motion is a yes or a no", typeof reduceMotion() === "boolean");

console.log("a clip that isn't there");
const missing = new VideoView({ src: join(import.meta.dir, "fixtures", "no-such-clip.mp4") });
check("is an empty view, not a throw", !missing.usable && !missing.ready && !missing.playing);
missing.play();
missing.dispose();
check("and play and dispose do nothing", !missing.playing);

console.log("a clip, behind a label");
const video = new VideoView({ src: clip });
const box = new Container({ width: 320, height: 200 });
box.fill(video);
box.fill(new Label({ text: "over the video" }));
const window = new Window({ title: "video", content: box, size: { width: 320, height: 200 } });
window.native.makeKeyAndOrderFront_(null);
check("is usable", video.usable);
check("its layer is the player's, hosted by the view", !!video.native.layer().isKindOfClass_(objc.AVPlayerLayer));
check("fills by default", str(video.native.layer().videoGravity()) === "AVLayerVideoGravityResizeAspectFill");
check("is muted", !!video.native.layer().player().isMuted());
check("doesn't keep the display awake", !video.native.layer().player().preventsDisplaySleepDuringVideoPlayback());
check("its first frame comes up", await until(() => video.ready), { ready: video.ready });
if (reduceMotion()) {
  check("reduce motion is on here: it shows the first frame, still", !video.playing);
  video.play();
}
check("it plays", await until(() => video.playing));
// Past the clip's one second: the looper has it playing still.
await until(() => false, 1600);
check("and loops past its end", video.playing);
video.pause();
check("pause stops it", !video.playing);
video.play();
check("play starts it again", await until(() => video.playing));
video.dispose();
check("dispose stops it for good", !video.playing);
video.play();
check("and play after dispose does nothing", !video.playing);

console.log("options");
const still = new VideoView({ src: clip, autoplay: false, gravity: "fit", loop: false, keepsDisplayAwake: true });
check("autoplay: false doesn't play", !still.playing);
check("fit letterboxes", str(still.native.layer().videoGravity()) === "AVLayerVideoGravityResizeAspect");
check("keepsDisplayAwake asks for it", !!still.native.layer().player().preventsDisplaySleepDuringVideoPlayback());
still.dispose();

console.log("a scrim");
const scrim = new ScrimView({ stops: [{ at: 0, alpha: 0.2 }, { at: 0.5, alpha: 0.5 }, { at: 1, alpha: 0.8 }] });
box.fill(scrim);
pumpOnce(0.01);
const gradient = scrim.native.layer();
check("is a gradient layer, hosted by the view", !!gradient.isKindOfClass_(objc.CAGradientLayer));
check("with a colour and a location per stop", Number(gradient.colors().count()) === 3 && Number(gradient.locations().objectAtIndex_(1).doubleValue()) === 0.5);
check("its first stop is the top", Number(gradient.startPoint().y) === 1 && Number(gradient.endPoint().y) === 0);
check("and it follows the view's size", Number(gradient.bounds().width) === 320);

window.native.close();
if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("video: all ok");
process.exit(0);
