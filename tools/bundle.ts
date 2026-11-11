// .app bundle builder.
//
//   bun run tools/bundle.ts examples/raw-objc.ts --name "Hello" --id com.example.hello
//
// A macOS process that is not inside a bundle gets the wrong menu-bar title, odd
// Dock behaviour, and no bundle identifier — which several system APIs
// (notifications, defaults, entitlements) quietly need. So shipping anything
// means producing this directory layout:
//
//   MyApp.app/Contents/Info.plist
//   MyApp.app/Contents/PkgInfo
//   MyApp.app/Contents/MacOS/MyApp            compiled Bun binary
//   MyApp.app/Contents/Frameworks/libobjcbridge.dylib
//   MyApp.app/Contents/Resources/AppIcon.icns
//   MyApp.app/Contents/Resources/Assets.car       (from a .icon: the Liquid Glass icon)
//
// The one genuinely tricky part is making the compiled binary find the dylib —
// see makeLauncher() below.

import { existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, chmodSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BundleOptions {
  /** TypeScript entry point. Relative paths resolve against the cwd. */
  entry: string;
  /**
   * Worker entry points compiled into the binary beside the app — the scripts the app
   * starts with `new Worker(new URL("./name.ts", import.meta.url))`. Relative paths resolve
   * against the cwd.
   *
   * `bun build --compile` only includes a worker it is given as an entry point of its own,
   * and in the binary every module's `import.meta.url` is the executable's
   * (`file:///$bunfs/root/<name>`), so `./name.ts` is looked for at the root of the bundled
   * file system. Each worker is therefore placed there under its own file name, through a
   * one-line shim; two workers may not share a file name. Without this a worker spawned
   * that way fails to load in the app and works from source, which is the worst way round.
   */
  workers?: string[];
  /** App name: the .app directory and the executable — and what people see, unless {@link displayName} says otherwise. */
  name?: string;
  /**
   * What people see the app called — Finder, the Dock, Launchpad, Spotlight, Get Info and the
   * menu bar — when that is not the file's name: `name: "hiettlight2"` (`hiettlight2.app`) shown
   * as **HiettLight 2**. Sets `CFBundleName` (the menu bar's) to it, and writes it as both
   * names to `Resources/en.lproj/InfoPlist.strings` with `LSHasLocalizedDisplayName`. The
   * `Info.plist`'s own `CFBundleDisplayName` stays the file's name: Finder shows the localized
   * name only when the unlocalized one matches the file, which is also how a renamed copy shows
   * its new name. Defaults to `name`.
   */
  displayName?: string;
  /** CFBundleIdentifier, e.g. "com.example.myapp". */
  identifier?: string;
  /** CFBundleShortVersionString — the human version, e.g. "1.2.0". */
  version?: string;
  /** CFBundleVersion — the build number. Defaults to `version`. */
  build?: string;
  /**
   * Icon source: an Icon Composer **.icon** (compiled with Xcode 26's `actool` into the
   * `Assets.car` macOS 26 draws as Liquid Glass — Default, Dark, Clear and Tinted — plus an
   * `.icns` for older systems; needs Xcode), a .png (converted with sips + iconutil), or a
   * ready .icns.
   */
  icon?: string;
  /** Directory the .app is written into. Default "dist". */
  out?: string;
  /** LSMinimumSystemVersion. Default "11.0". */
  minimumSystemVersion?: string;
  /** Extra files or directories copied into Contents/Resources. */
  resources?: string[];
  /** Path to libobjcbridge.dylib. Defaults to <repo>/build/libobjcbridge.dylib. */
  dylib?: string;
  /** bun build --compile target triple. arm64 only; overriding is unsupported. */
  target?: string;
  /** Minify the compiled bundle. */
  minify?: boolean;
  /**
   * Codesign identity. "-" (the default) is an ad-hoc signature, which is all
   * that is needed to run locally. Pass a "Developer ID Application: ..." string
   * for a distributable build.
   */
  sign?: string | false;
  /** Hardened runtime. Forced on for a non-ad-hoc identity; see signBundle(). */
  hardenedRuntime?: boolean;
  /** Entitlements plist. One suitable for Bun's JIT is generated if omitted. */
  entitlements?: string;
  /** LSApplicationCategoryType, e.g. "public.app-category.developer-tools". */
  category?: string;
  /** NSHumanReadableCopyright. */
  copyright?: string;
  /** LSUIElement — a menu-bar-only app with no Dock icon. */
  agent?: boolean;
  /** Extra Info.plist keys, merged last so they can override anything above. */
  plist?: Record<string, PlistValue>;
  /** Print each step. Default true from the CLI. */
  verbose?: boolean;
}

export interface BundleResult {
  appPath: string;
  executable: string;
  infoPlist: string;
  dylib: string;
  icon: string | null;
  identifier: string;
  name: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(on: boolean, ...args: unknown[]) {
  if (on) console.log(...args);
}

function run(cmd: string[], what: string): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    const err = p.stderr.toString().trim() || p.stdout.toString().trim();
    throw new Error(`${what} failed (exit ${p.exitCode})\n  ${cmd.join(" ")}\n${err}`);
  }
  return p.stdout.toString();
}

/** "raw-objc" -> "RawObjc"; already-cased names are left alone. */
function titleCase(s: string): string {
  return s
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z]/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
}

/**
 * `InfoPlist.strings` naming a bundle `displayName`: `CFBundleName` and `CFBundleDisplayName`,
 * quoted as a strings file wants (backslashes and quotes escaped). Pure.
 */
export function infoPlistStrings(displayName: string): string {
  const quoted = `"${displayName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `CFBundleName = ${quoted};\nCFBundleDisplayName = ${quoted};\n`;
}

/** Bundle identifiers may only contain alphanumerics, hyphen and dot. */
function idSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function dirSize(path: string): number {
  const out = run(["du", "-sk", path], "du");
  return parseInt(out.trim().split(/\s+/)[0]!, 10) * 1024;
}

// ---------------------------------------------------------------------------
// Property lists
// ---------------------------------------------------------------------------

export type PlistValue = string | number | boolean | PlistValue[] | { [k: string]: PlistValue };

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistBody(v: PlistValue, indent: string): string {
  if (typeof v === "string") return `${indent}<string>${xmlEscape(v)}</string>`;
  if (typeof v === "boolean") return `${indent}<${v}/>`;
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? `${indent}<integer>${v}</integer>`
      : `${indent}<real>${v}</real>`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return `${indent}<array/>`;
    const items = v.map((x) => plistBody(x, indent + "\t")).join("\n");
    return `${indent}<array>\n${items}\n${indent}</array>`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return `${indent}<dict/>`;
  const items = keys
    .map((k) => `${indent}\t<key>${xmlEscape(k)}</key>\n${plistBody(v[k]!, indent + "\t")}`)
    .join("\n");
  return `${indent}<dict>\n${items}\n${indent}</dict>`;
}

export function plist(dict: Record<string, PlistValue>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistBody(dict, ""),
    "</plist>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The launcher shim
// ---------------------------------------------------------------------------

// bridge.ts locates the dylib relative to its own source directory — which does
// not exist once `bun build --compile` has folded every module into one binary
// (import.meta.url becomes file:///$bunfs/root/...). The env var it checks first
// is the reliable route, so the real entry point is wrapped in a shim that sets
// OBJCBRIDGE_DYLIB from process.execPath, which *is* the path of the binary
// inside Contents/MacOS.
//
// The entry is imported dynamically on purpose: a static import would be hoisted
// above the assignment and bridge.ts would dlopen before the env var was set.
//
// `entryFile` is the specifier the launcher imports the entry by, relative to the launcher.
function launcherSource(entryFile: string): string {
  return `// Generated by tools/bundle.ts. Deleted when the build finishes.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const explicit = process.env.OBJCBRIDGE_DYLIB;
if (!explicit || !existsSync(explicit)) {
  const exeDir = dirname(process.execPath);
  const candidates = [
    resolve(exeDir, "../Frameworks/libobjcbridge.dylib"), // Contents/Frameworks
    resolve(exeDir, "libobjcbridge.dylib"),               // next to the binary
    resolve(exeDir, "../Resources/libobjcbridge.dylib"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      process.env.OBJCBRIDGE_DYLIB = c;
      break;
    }
  }
}

await import(${JSON.stringify(entryFile)});
`;
}

/**
 * A worker's shim: placed at the root of the bundle's file system under the worker's own
 * file name, it runs the real worker by importing it. `specifier` is relative to the shim.
 */
function workerShimSource(specifier: string): string {
  return `// Generated by tools/bundle.ts. Deleted when the build finishes.
import ${JSON.stringify(specifier)};
`;
}

/** The launcher's file name in the staging directory — so no worker may have it. */
const LAUNCHER = "launcher.ts";

/**
 * Where each worker's shim goes in `staging` and what it says: one file per worker, named as
 * the worker is, importing it by a path relative to `staging`. Pure.
 *
 * @throws if two workers share a file name, or one is called what the launcher is — both would
 *   be one file at the bundle's root.
 */
export function workerShims(
  staging: string,
  workers: readonly string[],
): { worker: string; path: string; source: string }[] {
  const names = new Set<string>([LAUNCHER]);
  return workers.map((worker) => {
    const name = basename(worker);
    if (names.has(name)) {
      throw new Error(`a worker can't be called ${name}: the bundle's root already has one`);
    }
    names.add(name);
    let specifier = relative(staging, worker).split(sep).join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    return { worker, path: join(staging, name), source: workerShimSource(specifier) };
  });
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

// The sizes Finder, the Dock and Get Info actually ask for. iconutil rejects an
// iconset that is missing any of them.
const ICON_SIZES: Array<[name: string, px: number]> = [
  ["icon_16x16", 16],
  ["icon_16x16@2x", 32],
  ["icon_32x32", 32],
  ["icon_32x32@2x", 64],
  ["icon_128x128", 128],
  ["icon_128x128@2x", 256],
  ["icon_256x256", 256],
  ["icon_256x256@2x", 512],
  ["icon_512x512", 512],
  ["icon_512x512@2x", 1024],
];

/**
 * Compile an Icon Composer `.icon` into `resourcesDir`: `Assets.car`, which carries the
 * layered Liquid Glass icon macOS 26 renders in each appearance, and `AppIcon.icns`, the
 * flattened fallback older systems (and `CFBundleIconFile`) read. Both are named `AppIcon`
 * whatever the source is called, because `actool --app-icon` names the asset after the
 * `.icon` it is given. Side effects: writes the two files; uses a scratch directory under the
 * system's temp folder, removed after. Throws, with actool's own message, when Xcode's
 * `actool` is missing or refuses the file.
 */
export function compileIcon(src: string, resourcesDir: string, minimum: string, verbose: boolean): void {
  const work = mkdtempSync(join(tmpdir(), "bunkit-icon-"));
  try {
    const named = join(work, "AppIcon.icon");
    cpSync(src, named, { recursive: true });
    const out = join(work, "out");
    mkdirSync(out);
    run(
      [
        "xcrun", "actool", named, "--compile", out, "--app-icon", "AppIcon",
        "--enable-on-demand-resources", "NO", "--development-region", "en",
        "--target-device", "mac", "--platform", "macosx",
        "--minimum-deployment-target", minimum,
        "--output-partial-info-plist", join(out, "partial.plist"),
      ],
      "actool (compiling a .icon needs Xcode 26)",
    );
    for (const file of ["Assets.car", "AppIcon.icns"]) {
      if (!existsSync(join(out, file))) throw new Error(`actool made no ${file} from ${basename(src)}`);
      cpSync(join(out, file), join(resourcesDir, file));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  log(verbose, `  icon      ${basename(src)} -> Assets.car + AppIcon.icns (actool)`);
}

function makeIcns(png: string, outIcns: string, verbose: boolean): void {
  const iconset = outIcns.replace(/\.icns$/, "") + ".iconset";
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const [name, px] of ICON_SIZES) {
    run(
      ["sips", "-z", String(px), String(px), png, "--out", join(iconset, `${name}.png`)],
      `sips ${px}x${px}`,
    );
  }
  run(["iconutil", "-c", "icns", iconset, "-o", outIcns], "iconutil");
  rmSync(iconset, { recursive: true, force: true });
  log(verbose, `  icon      ${basename(png)} -> ${basename(outIcns)} (10 sizes)`);
}

// ---------------------------------------------------------------------------
// Codesigning
// ---------------------------------------------------------------------------

// Bun JITs, so a hardened-runtime build dies at launch without these. Library
// validation is disabled because libobjcbridge.dylib is signed by us rather than
// by Apple — with a real Developer ID it would pass either way, but an ad-hoc or
// mixed-identity build would not.
const JIT_ENTITLEMENTS: Record<string, PlistValue> = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
  "com.apple.security.cs.disable-library-validation": true,
};

function signBundle(
  appPath: string,
  dylibPath: string,
  identity: string,
  opts: { hardened: boolean; entitlements?: string; identifier: string; verbose: boolean },
): void {
  // Nested code first: signing the bundle seals whatever is inside it, so a
  // dylib signed afterwards would invalidate the enclosing signature.
  // A loose dylib has no Info.plist to take an identifier from, and codesign's
  // generated fallback is a filename plus a UUID hash — name it explicitly.
  const inner = [
    "codesign", "--force", "--timestamp=none",
    "--identifier", `${opts.identifier}.objcbridge`,
    "--sign", identity,
  ];
  if (opts.hardened) inner.push("--options", "runtime");
  run([...inner, dylibPath], "codesign (dylib)");
  log(opts.verbose, `  sign      Frameworks/${basename(dylibPath)}`);

  const outer = ["codesign", "--force", "--timestamp=none", "--sign", identity];
  if (opts.hardened) outer.push("--options", "runtime");
  if (opts.entitlements) outer.push("--entitlements", opts.entitlements);
  run([...outer, appPath], "codesign (bundle)");
  log(opts.verbose, `  sign      ${basename(appPath)} (${identity === "-" ? "ad-hoc" : identity})`);

  run(["codesign", "--verify", "--deep", "--strict", appPath], "codesign --verify");
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const verbose = options.verbose !== false;

  const entry = resolve(options.entry);
  if (!existsSync(entry)) throw new Error(`entry point not found: ${entry}`);

  const name = options.name ?? titleCase(basename(entry, extname(entry)));
  const displayName = options.displayName ?? name;
  const identifier = options.identifier ?? `com.example.${idSafe(name)}`;
  const version = options.version ?? "1.0.0";
  const buildVersion = options.build ?? version;
  const outDir = resolve(options.out ?? "dist");
  const target = options.target ?? "bun-darwin-arm64";

  const dylib = resolve(options.dylib ?? join(REPO_ROOT, "build", "libobjcbridge.dylib"));
  if (!existsSync(dylib)) {
    throw new Error(`libobjcbridge.dylib not found at ${dylib}. Run ./native/build.sh first.`);
  }

  const appPath = join(outDir, `${name}.app`);
  const contents = join(appPath, "Contents");
  const macOS = join(contents, "MacOS");
  const frameworks = join(contents, "Frameworks");
  const resourcesDir = join(contents, "Resources");

  log(verbose, `building ${name}.app`);
  log(verbose, `  entry     ${entry}`);
  checkArch(dylib, target, verbose);

  rmSync(appPath, { recursive: true, force: true });
  for (const d of [macOS, frameworks, resourcesDir]) mkdirSync(d, { recursive: true });

  // --- compile -------------------------------------------------------------
  // The launcher — and a shim per worker — live in a staging directory beside the
  // entry, so node_modules resolution behaves exactly as it does for the entry itself.
  // Every entry point the compiler is given sits in that one directory, which makes it
  // the root of the bundled file system: the shims land at `/$bunfs/root/<name>`, which
  // is where `new URL("./<name>", import.meta.url)` looks in the binary.
  const workers = (options.workers ?? []).map((w) => resolve(w));
  for (const worker of workers) {
    if (!existsSync(worker)) throw new Error(`worker not found: ${worker}`);
  }
  const staging = join(dirname(entry), `.bundle-${process.pid}`);
  const planned = workerShims(staging, workers);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const launcher = join(staging, LAUNCHER);
  writeFileSync(launcher, launcherSource(`../${basename(entry)}`));
  const shims = planned.map(({ path, source, worker }) => {
    writeFileSync(path, source);
    log(verbose, `  worker    ${worker}`);
    return path;
  });
  // Compiling 60-odd MB takes a moment; Ctrl-C in the middle must not leave a
  // generated file sitting in someone's source directory.
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const sweep = () => rmSync(staging, { recursive: true, force: true });
  const onSignal = () => {
    sweep();
    process.exit(130);
  };
  for (const sig of SIGNALS) process.on(sig, onSignal);

  const exePath = join(macOS, name);
  try {
    const cmd = [
      "bun",
      "build",
      "--compile",
      `--target=${target}`,
      launcher,
      ...shims,
      "--outfile",
      exePath,
    ];
    if (options.minify) cmd.push("--minify");
    run(cmd, "bun build --compile");
  } finally {
    sweep();
    for (const sig of SIGNALS) process.off(sig, onSignal);
  }
  chmodSync(exePath, 0o755);
  log(verbose, `  compile   MacOS/${name} (${(statSync(exePath).size / 1e6).toFixed(1)} MB, ${target})`);

  // --- dylib ---------------------------------------------------------------
  const bundledDylib = join(frameworks, basename(dylib));
  cpSync(dylib, bundledDylib);
  chmodSync(bundledDylib, 0o755);
  log(verbose, `  embed     Frameworks/${basename(dylib)}`);

  // --- icon ----------------------------------------------------------------
  let iconFile: string | null = null;
  /** Whether the icon is also in Assets.car, named by `CFBundleIconName`. */
  let iconAsset = false;
  if (options.icon) {
    const src = resolve(options.icon);
    if (!existsSync(src)) throw new Error(`icon not found: ${src}`);
    const ext = extname(src).toLowerCase();
    iconFile = join(resourcesDir, "AppIcon.icns");
    if (ext === ".icns") {
      cpSync(src, iconFile);
      log(verbose, `  icon      ${basename(src)} (copied)`);
    } else if (ext === ".png") {
      makeIcns(src, iconFile, verbose);
    } else if (ext === ".icon") {
      compileIcon(src, resourcesDir, options.minimumSystemVersion ?? "11.0", verbose);
      iconAsset = true;
    } else {
      throw new Error(`icon must be a .icon, .png or .icns, got ${ext || "no extension"}`);
    }
  }

  // --- extra resources -----------------------------------------------------
  for (const r of options.resources ?? []) {
    const src = resolve(r);
    if (!existsSync(src)) throw new Error(`resource not found: ${src}`);
    cpSync(src, join(resourcesDir, basename(src)), { recursive: true });
    log(verbose, `  resource  Resources/${basename(src)}`);
  }

  // --- Info.plist ----------------------------------------------------------
  const info: Record<string, PlistValue> = {
    CFBundleDevelopmentRegion: "en",
    // The file's name here and the shown name in `en.lproj` below: Finder takes the localized
    // name only when the unlocalized one matches the file it is reading (`hiettlight2.app`).
    CFBundleDisplayName: name,
    CFBundleExecutable: name,
    CFBundleIdentifier: identifier,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: displayName,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleSignature: "????",
    CFBundleVersion: buildVersion,
    LSMinimumSystemVersion: options.minimumSystemVersion ?? "11.0",
    NSHighResolutionCapable: true,
    // Without this AppKit will not treat the process as a real app: no menu bar
    // ownership, no proper activation.
    NSPrincipalClass: "NSApplication",
  };
  if (iconFile) info.CFBundleIconFile = "AppIcon";
  if (iconAsset) info.CFBundleIconName = "AppIcon";
  if (displayName !== name) {
    // Finder shows a bundle's *file* name unless it is told the bundle has a localized one.
    info.LSHasLocalizedDisplayName = true;
    const lproj = join(resourcesDir, "en.lproj");
    mkdirSync(lproj, { recursive: true });
    writeFileSync(join(lproj, "InfoPlist.strings"), infoPlistStrings(displayName));
    log(verbose, `  name      ${name}.app, shown as "${displayName}"`);
  }
  if (options.category) info.LSApplicationCategoryType = options.category;
  if (options.copyright) info.NSHumanReadableCopyright = options.copyright;
  if (options.agent) info.LSUIElement = true;
  Object.assign(info, options.plist ?? {});

  const infoPlist = join(contents, "Info.plist");
  writeFileSync(infoPlist, plist(info));
  writeFileSync(join(contents, "PkgInfo"), "APPL????");
  log(verbose, `  plist     Contents/Info.plist (${identifier} ${version}/${buildVersion})`);

  // --- codesign ------------------------------------------------------------
  if (options.sign !== false) {
    const identity = options.sign ?? "-";
    const adhoc = identity === "-";
    // Hardened runtime plus an ad-hoc signature is rejected by Gatekeeper, so it
    // is only meaningful (and only defaulted on) for a real identity.
    const hardened = options.hardenedRuntime ?? !adhoc;
    let entitlements = options.entitlements ? resolve(options.entitlements) : undefined;
    if (hardened && !entitlements) {
      // Kept on disk rather than in a temp dir so it can be inspected, and so a
      // later notarytool run can be pointed at the exact file that was used.
      entitlements = join(outDir, `.${name}.entitlements`);
      writeFileSync(entitlements, plist(JIT_ENTITLEMENTS));
      log(verbose, `  entitle   ${entitlements} (generated: JIT for Bun)`);
    }
    signBundle(appPath, bundledDylib, identity, { hardened, entitlements, identifier, verbose });
  } else {
    log(verbose, "  sign      skipped (--no-sign)");
  }

  const bytes = dirSize(appPath);
  log(verbose, `done      ${appPath} (${(bytes / 1e6).toFixed(1)} MB)`);

  return {
    appPath,
    executable: exePath,
    infoPlist,
    dylib: bundledDylib,
    icon: iconFile,
    identifier,
    name,
    bytes,
  };
}

/**
 * Refuse a target the bridge cannot serve.
 *
 * BunKit is arm64-only — the dispatcher is written to that ABI — so a
 * bun-darwin-x64 build would produce an app that loads a dylib with no matching
 * slice. Better to stop here than to ship it.
 */
function checkArch(dylib: string, target: string, verbose: boolean): void {
  if (target.includes("x64") || target.includes("x86_64")) {
    throw new Error(
      `target "${target}" is Intel, but BunKit is arm64-only. Use bun-darwin-arm64.`,
    );
  }
  let have: string;
  try {
    have = run(["lipo", "-archs", dylib], "lipo -archs").trim();
  } catch {
    return;
  }
  if (!have.split(/\s+/).includes("arm64")) {
    throw new Error(
      `${basename(dylib)} has [${have}] but arm64 is required; run ./native/build.sh`,
    );
  }
  log(verbose, `  arch      arm64`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `bundle — build a macOS .app around a Bun entry point

  bun run tools/bundle.ts <entry.ts> [options]

  --name <s>          app name (default: derived from the entry filename)
  --id <s>            CFBundleIdentifier (default: com.example.<name>)
  --version <s>       CFBundleShortVersionString (default: 1.0.0)
  --build <s>         CFBundleVersion (default: same as --version)
  --icon <path>       .png (converted with sips/iconutil) or .icns
  --out <dir>         output directory (default: dist)
  --min-os <s>        LSMinimumSystemVersion (default: 11.0)
  --resource <path>   extra file/dir copied into Resources (repeatable)
  --worker <path>     a worker entry point compiled in, at the bundle's root (repeatable)
  --dylib <path>      libobjcbridge.dylib (default: <repo>/build/)
  --category <s>      LSApplicationCategoryType
  --copyright <s>     NSHumanReadableCopyright
  --agent             menu-bar-only app (LSUIElement)
  --minify            minify the compiled JS
  --sign <identity>   codesign identity; default "-" (ad-hoc)
                      e.g. --sign "Developer ID Application: Acme (TEAMID)"
  --no-sign           do not codesign at all
  --hardened          force --options runtime (default: on for a real identity)
  --no-hardened       force it off
  --entitlements <p>  entitlements plist for signing
                      (one granting Bun's JIT is generated if omitted)
  --config <file.ts>  load options from a module's default export
  --quiet             no progress output
  --help

Notarization is out of scope: sign, then run notarytool yourself.
`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        name: { type: "string" },
        id: { type: "string" },
        version: { type: "string" },
        build: { type: "string" },
        icon: { type: "string" },
        out: { type: "string", short: "o" },
        "min-os": { type: "string" },
        resource: { type: "string", multiple: true },
        worker: { type: "string", multiple: true },
        dylib: { type: "string" },
        target: { type: "string" },
        category: { type: "string" },
        copyright: { type: "string" },
        agent: { type: "boolean" },
        minify: { type: "boolean" },
        sign: { type: "string" },
        "no-sign": { type: "boolean" },
        hardened: { type: "boolean" },
        "no-hardened": { type: "boolean" },
        entitlements: { type: "string" },
        config: { type: "string" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e: any) {
    console.error(`bundle: ${e.message}\n`);
    console.error(USAGE);
    return 2;
  }

  const { values: v, positionals } = parsed;
  if (v.help) {
    console.log(USAGE);
    return 0;
  }

  // Config file first; explicit flags win over it. Paths inside a config are
  // relative to that file rather than the cwd, so it can be run from anywhere.
  let cfg: Partial<BundleOptions> = {};
  if (v.config) {
    const configPath = resolve(v.config);
    const mod = await import(pathToFileURL(configPath).href);
    cfg = { ...((mod.default ?? mod) as Partial<BundleOptions>) };
    const base = dirname(configPath);
    for (const k of ["entry", "out", "icon", "dylib", "entitlements"] as const) {
      if (cfg[k]) (cfg as Record<string, unknown>)[k] = resolve(base, cfg[k] as string);
    }
    if (cfg.resources) cfg.resources = cfg.resources.map((r) => resolve(base, r));
    if (cfg.workers) cfg.workers = cfg.workers.map((w) => resolve(base, w));
  }

  // A positional entry is relative to the cwd; one from a config was rebased above.
  const entry = positionals[0] ?? cfg.entry;
  if (!entry) {
    console.error("bundle: no entry point given\n");
    console.error(USAGE);
    return 2;
  }

  const options: BundleOptions = {
    ...cfg,
    entry,
    name: v.name ?? cfg.name,
    identifier: v.id ?? cfg.identifier,
    version: v.version ?? cfg.version,
    build: v.build ?? cfg.build,
    icon: v.icon ?? cfg.icon,
    out: v.out ?? cfg.out,
    minimumSystemVersion: v["min-os"] ?? cfg.minimumSystemVersion,
    resources: v.resource ?? cfg.resources,
    workers: v.worker ?? cfg.workers,
    dylib: v.dylib ?? cfg.dylib,
    target: v.target ?? cfg.target,
    category: v.category ?? cfg.category,
    copyright: v.copyright ?? cfg.copyright,
    agent: v.agent ?? cfg.agent,
    minify: v.minify ?? cfg.minify,
    sign: v["no-sign"] ? false : (v.sign ?? cfg.sign),
    hardenedRuntime: v.hardened ? true : v["no-hardened"] ? false : cfg.hardenedRuntime,
    entitlements: v.entitlements ?? cfg.entitlements,
    verbose: v.quiet ? false : (cfg.verbose ?? true),
  };

  try {
    await bundle(options);
    return 0;
  } catch (e: any) {
    console.error(`bundle: ${e.message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
