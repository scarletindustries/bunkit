#!/usr/bin/env bash
# Build libobjcbridge.dylib.
#
#   ./native/build.sh
#
# arm64 only, deliberately. That removes the whole objc_msgSend_stret / _fpret
# family from the dispatcher: on arm64 every struct return goes through plain
# objc_msgSend with x8 as the indirect result register.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/src"
OUT="$ROOT/build"

ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "error: this builds for Apple silicon only, but uname -m says '$ARCH'." >&2
  echo "       The dispatcher assumes the arm64 ABI; an Intel build would" >&2
  echo "       mis-return every struct rather than fail loudly." >&2
  exit 1
fi

mkdir -p "$OUT"

echo "  clang -arch arm64"
clang -arch arm64 \
  -dynamiclib \
  -fno-objc-arc `# the bridge manages retain/release explicitly` \
  -fobjc-exceptions \
  -O2 -g \
  -Wall -Wno-unused-parameter -Wno-deprecated-declarations \
  -install_name "@rpath/libobjcbridge.dylib" \
  -framework Cocoa \
  -framework CoreGraphics \
  -framework QuartzCore \
  -framework Network `# net.m: listeners, browsers, connections` \
  -framework Security `# net.m: TLS with pre-shared keys` \
  -lffi \
  -o "$OUT/libobjcbridge.dylib" \
  "$SRC"/*.m

echo "built $OUT/libobjcbridge.dylib"
nm -gU "$OUT/libobjcbridge.dylib" | grep ' T _br_' | sed 's/.* T _/  /' | sort
