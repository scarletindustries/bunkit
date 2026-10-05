# Working in this repo

## Commits

- 12 words or fewer. No body.
- All lowercase.
- No tool attribution, co-author trailers, or generated-by footers.

```
add libffi closure trampolines for delegate callbacks
fix autorelease pool leak in the run loop
```

## Before you push

```bash
./native/build.sh          # the dylib is not committed
bun run typecheck          # must be 0 errors
bun test                   # all suites
```

Changing anything under `native/` means rebuilding the dylib before the TypeScript
side will even load — `dlopen` fails on a missing symbol, not at the call site.

## The annoying parts

- **arm64 only, on purpose.** The dispatcher is written to the arm64 ABI, where
  struct returns use `x8` and `objc_msgSend_stret` does not exist. Do not add
  architecture conditionals back; `native/build.sh`, `src/bridge.ts` and the
  bundler all refuse anything else on purpose.

- **Obj-C pointers are `bigint`, never `number`.** Tagged pointers (short strings,
  small numbers, dates) exceed 2^53. Compare against `0n`.
- **Never add a `runModal*` call to `src/ui/`.** It spins a nested run loop that
  `br_pump` does not return from, which freezes all of JavaScript. Sheets only.
- **Enum values are generated, not hand-written.** `src/ui/appkit.ts` derives from
  `src/generated/constants.ts`. Typing a value in by hand is how you get
  `NSTextAlignment` wrong on arm64.
- **`objc.Foo` throws on an unknown class** — use `tryClass("Foo")` when probing.
  An `ObjCObject` is a Proxy that answers every property with a method, so
  `x.maybeThing?.()` never short-circuits.
- **Run `test/soak.ts` after touching memory or delegate code.** Leaks here are
  linear and invisible in a short test.
- **A wrapper holds its object until it is garbage-collected.** Usually harmless;
  not for anything from a small pool. A `CAMetalDrawable` taken and never presented
  stays checked out of the layer's three until its wrapper is collected, and the
  next `nextDrawable` waits a second for it — `dispose()` it the moment it is
  discarded (`metal/view.ts` does).
