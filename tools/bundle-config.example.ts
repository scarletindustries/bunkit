// Example bundle configuration — copy it next to your app and edit.
//
//   bun run tools/bundle.ts --config tools/bundle-config.example.ts
//
// Every field is optional except `entry`, and every field has a matching CLI
// flag which wins over the value here. Paths in this file are resolved relative
// to the config file itself, so it can live wherever the app does.
//
// It is a real TypeScript module, so anything computable is fair game:
//
//   version: (await Bun.file("package.json").json()).version,
//   sign: process.env.CI ? process.env.SIGN_IDENTITY : "-",

import type { BundleOptions } from "./bundle.ts";

const config: BundleOptions = {
  // --- required ------------------------------------------------------------

  /** The TypeScript entry point. It is compiled with `bun build --compile`. */
  entry: "../examples/raw-objc.ts",

  // --- identity ------------------------------------------------------------

  /**
   * The app's name. Becomes the .app directory name, CFBundleName,
   * CFBundleDisplayName and the executable in Contents/MacOS.
   * Default: the entry filename in TitleCase ("raw-objc.ts" -> "RawObjc").
   *
   * This is what the menu bar shows — the single most visible reason a real
   * bundle is required.
   */
  name: "RawObjC",

  /**
   * CFBundleIdentifier. Reverse-DNS, unique per app: macOS keys preferences,
   * notification authorisation, keychain items and TCC grants off it.
   * Default: com.example.<name>
   */
  identifier: "com.scarletindustries.hellobundle",

  /** CFBundleShortVersionString — the version users see. Default "1.0.0". */
  version: "1.0.0",

  /**
   * CFBundleVersion — the build number. Must increase with every release you
   * ship; the App Store and Sparkle both compare it. Default: same as `version`.
   */
  build: "7",

  /** NSHumanReadableCopyright, shown in the About panel. */
  copyright: "© 2026 Scarlet Industries",

  /** LSApplicationCategoryType. Required by the App Store, harmless otherwise. */
  category: "public.app-category.developer-tools",

  // --- packaging -----------------------------------------------------------

  /** Directory the .app is written into. Default "dist". */
  out: "../dist",

  /**
   * App icon. An Icon Composer .icon is compiled with Xcode 26's actool into the
   * Assets.car macOS 26 draws as Liquid Glass, plus an .icns for older systems. A
   * .png (1024x1024 works best) is converted to .icns with sips and iconutil at
   * the ten sizes Finder and the Dock ask for; a .icns is copied straight through.
   * Omit for the generic application icon.
   */
  // icon: "../assets/icon.png",

  /** Extra files and directories copied into Contents/Resources. */
  // resources: ["../assets/sounds", "../assets/default-config.json"],

  /** LSMinimumSystemVersion. Default "11.0". */
  minimumSystemVersion: "11.0",

  /**
   * LSUIElement — a menu-bar-only app: no Dock icon, no menu bar of its own.
   * Pair it with `initApp(ActivationPolicy.Accessory)`.
   */
  // agent: true,

  /**
   * Arbitrary extra Info.plist keys, merged last so they override anything the
   * bundler generates. Usage-description strings live here.
   */
  // plist: {
  //   NSMicrophoneUsageDescription: "Recording calls.",
  //   CFBundleURLTypes: [
  //     { CFBundleURLName: "hello", CFBundleURLSchemes: ["hello"] },
  //   ],
  // },

  // --- build ---------------------------------------------------------------

  /**
   * bun build --compile target triple. BunKit is arm64-only, so this exists to
   * pin the value rather than to offer a choice.
   */
  target: "bun-darwin-arm64",

  /** Path to libobjcbridge.dylib. Default: <repo>/build/libobjcbridge.dylib. */
  // dylib: "../build/libobjcbridge.dylib",

  /** Minify the compiled JavaScript. Saves a little; makes stack traces worse. */
  minify: false,

  // --- signing -------------------------------------------------------------

  /**
   * Codesign identity, applied to the dylib first and then the whole bundle.
   *
   *   "-"      ad-hoc (the default) — runs on this machine, and only this one
   *   "Developer ID Application: Acme Inc (TEAM1D)"  — distributable
   *   false    skip signing entirely
   *
   * `security find-identity -v -p codesigning` lists what you have.
   * Notarization is deliberately out of scope: sign here, then run
   * `xcrun notarytool submit` and `xcrun stapler staple` yourself.
   */
  sign: "-",

  /**
   * Hardened runtime (`codesign --options runtime`). Defaults to on for a real
   * identity and off for ad-hoc, because Gatekeeper rejects the combination of
   * hardened runtime and an ad-hoc signature.
   *
   * When it is on and no `entitlements` file is given, the bundler writes one
   * granting the JIT permissions Bun cannot start without.
   */
  // hardenedRuntime: true,
  // entitlements: "../assets/app.entitlements",

  /** Progress output. Default true. */
  verbose: true,
};

export default config;
