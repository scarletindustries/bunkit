// Video, through AVFoundation: a muted clip that plays (and usually loops) behind other views —
// and the scrim that goes over it so the words on top stay readable.
//
// What a welcome window, a title card or an "about" pane puts a moving picture in. Not a
// player: no controls, no sound, no scrubbing — `AVKit`'s `AVPlayerView` is that, and a
// background must not look like something to press.
//
// The view is **layer-hosting**: its layer *is* the `AVPlayerLayer`, so it follows the view's
// size with no layout of its own. Put views over it as siblings (a `Container`'s `fill`, in
// order), never as its subviews — a layer-hosting view does not lay out subviews.

import { existsSync } from "node:fs";
import { globalObject, objc, tryClass, wrap } from "../objc.ts";
import { NIL } from "../bridge.ts";
import { toNSColor, View, type ViewOptions } from "./view.ts";

let loaded: boolean | undefined;

/**
 * Whether AVFoundation is loaded and its player classes are there. Loads the framework the
 * first time it is asked (a few milliseconds); answers from memory after that. Side effect:
 * `AVFoundation.framework` is loaded into the process.
 */
export function avFoundationAvailable(): boolean {
  if (loaded === undefined) {
    try {
      const bundle = objc.NSBundle.bundleWithPath_("/System/Library/Frameworks/AVFoundation.framework");
      loaded = !!bundle && bundle.ptr !== NIL && !!bundle.load();
    } catch {
      loaded = false;
    }
    loaded = loaded && tryClass("AVQueuePlayer") !== null && tryClass("AVPlayerLooper") !== null;
  }
  return loaded;
}

/**
 * Whether the person has asked macOS to **reduce motion** (Accessibility ▸ Display). A video
 * that plays behind a window is exactly the motion that setting is for. Side effect-free.
 */
export function reduceMotion(): boolean {
  try {
    return !!objc.NSWorkspace.sharedWorkspace().accessibilityDisplayShouldReduceMotion();
  } catch {
    return false;
  }
}

/** How a {@link VideoView} is made. */
export interface VideoViewOptions extends ViewOptions {
  /** The clip: a file path. A file that isn't there leaves the view empty, never a throw. */
  src: string;
  /**
   * How the picture meets the view: `"fill"` (the default) covers it and crops the overflow,
   * as a background should; `"fit"` letterboxes the whole picture.
   */
  gravity?: "fill" | "fit";
  /** Play it again from the start when it ends, seamlessly (`AVPlayerLooper`). Default `true`. */
  loop?: boolean;
  /**
   * Start playing as soon as it is made. Default `true` — **unless the person has asked macOS
   * to reduce motion**, when the view shows the clip's first frame, still, until {@link
   * VideoView.play} is called. Choose the clip's first frame with that in mind.
   */
  autoplay?: boolean;
  /**
   * Whether the display may not sleep while it plays. Default `false`: a background clip is not
   * something being watched. (AVFoundation's own default is the opposite.)
   */
  keepsDisplayAwake?: boolean;
}

/**
 * A muted clip in a view — see the module doc. Construct it, place it, and call {@link dispose}
 * when the view goes: a player left running decodes into a window nobody can see.
 *
 * Never throws for a missing file or a machine without AVFoundation: the view is then simply
 * empty ({@link ready} stays false), because a background is never worth an error.
 */
export class VideoView extends View {
  readonly #player: any;
  readonly #looper: any;
  readonly #layer: any;
  #disposed = false;

  constructor(options: VideoViewOptions) {
    const view = objc.NSView.alloc().init();
    super(view, options);
    const usable = existsSync(options.src) && avFoundationAvailable();
    if (!usable) {
      view.setWantsLayer_(true);
      return;
    }
    const url = objc.NSURL.fileURLWithPath_(options.src);
    const item = objc.AVPlayerItem.playerItemWithURL_(url);
    const player = objc.AVQueuePlayer.alloc().init();
    player.setMuted_(true);
    player.setPreventsDisplaySleepDuringVideoPlayback_(options.keepsDisplayAwake === true);
    if (options.loop === false) player.insertItem_afterItem_(item, null);
    this.#looper = options.loop === false ? undefined : objc.AVPlayerLooper.playerLooperWithPlayer_templateItem_(player, item);
    const layer = objc.AVPlayerLayer.playerLayerWithPlayer_(player);
    const gravity = options.gravity === "fit" ? "AVLayerVideoGravityResizeAspect" : "AVLayerVideoGravityResizeAspectFill";
    layer.setVideoGravity_(globalObject(gravity) ?? gravity);
    // Layer-hosting: the layer is set before `wantsLayer`, so AppKit hosts it rather than
    // making one of its own — and sizes it with the view.
    view.setLayer_(layer);
    view.setWantsLayer_(true);
    this.#player = player;
    this.#layer = layer;
    this.retainJS(player);
    this.retainJS(layer);
    if (this.#looper) this.retainJS(this.#looper);
    if (options.autoplay !== false && !reduceMotion()) player.play();
  }

  /** Whether there is a clip at all: the file was there and AVFoundation could play it. */
  get usable(): boolean {
    return this.#player !== undefined;
  }

  /**
   * Whether the first frame is ready to show (`AVPlayerLayer.readyForDisplay`). False until
   * AVFoundation has opened the file — a moment after construction, on its own threads — and
   * for a view with no clip.
   */
  get ready(): boolean {
    return this.#layer !== undefined && !!this.#layer.isReadyForDisplay();
  }

  /** Whether it is playing now. */
  get playing(): boolean {
    return this.#player !== undefined && Number(this.#player.rate()) > 0;
  }

  /** Play, or carry on playing. Nothing after {@link dispose}. */
  play(): void {
    if (!this.#disposed) this.#player?.play();
  }

  /** Pause on the current frame, which stays on screen. */
  pause(): void {
    this.#player?.pause();
  }

  /**
   * Stop for good and let the decoder go: stops looping, pauses, empties the queue and takes
   * the player off the layer. The view stays, blank. Idempotent.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (!this.#player) return;
    this.#looper?.disableLooping();
    this.#player.pause();
    this.#player.removeAllItems();
    this.#layer.setPlayer_(null);
  }
}

/** One stop of a {@link ScrimView}: how far down (0 the top, 1 the bottom) and how opaque. */
export interface ScrimStop {
  at: number;
  alpha: number;
}

/** How a {@link ScrimView} is made. */
export interface ScrimViewOptions extends ViewOptions {
  /**
   * The opacity, top to bottom: two stops or more, at increasing `at`. A constant scrim is two
   * stops of the same alpha.
   */
  stops: readonly ScrimStop[];
  /** The colour, at full opacity — a name, hex or `NSColor`. Default black. */
  color?: any;
}

/**
 * A gradient of one colour's opacity, top to bottom: what goes over a {@link VideoView} (or a
 * picture) so the words on top stay readable while the picture shows round them. Layer-hosting,
 * like the video — a `CAGradientLayer` that follows the view's size. It does nothing with a click:
 * put the controls above it, in a `Container`'s `fill` after it.
 */
export class ScrimView extends View {
  constructor(options: ScrimViewOptions) {
    const view = objc.NSView.alloc().init();
    super(view, options);
    const base = toNSColor(options.color ?? "black");
    const colors = objc.NSMutableArray.array();
    const locations = objc.NSMutableArray.array();
    for (const stop of options.stops) {
      // CGColorRef comes back as a bare pointer; an NSArray holds it as the object it bridges to.
      colors.addObject_(wrap(base.colorWithAlphaComponent_(stop.alpha).CGColor()));
      locations.addObject_(objc.NSNumber.numberWithDouble_(stop.at));
    }
    const layer = objc.CAGradientLayer.layer();
    layer.setColors_(colors);
    layer.setLocations_(locations);
    // A layer's y runs up the screen: the first stop, `at: 0`, is the view's top.
    layer.setStartPoint_({ x: 0.5, y: 1 });
    layer.setEndPoint_({ x: 0.5, y: 0 });
    view.setLayer_(layer);
    view.setWantsLayer_(true);
    this.retainJS(layer);
  }
}
