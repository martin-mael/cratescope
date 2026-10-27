#!/bin/sh
# Fetches ffmpeg + ffprobe for a target into vendor/<platform>-<arch>/ffmpeg
# (shipped inside the packaged app as resources/ffmpeg).
#   win32-x64     : LGPL shared build from BtbN/FFmpeg-Builds
#   darwin-arm64/x64 : static builds from ffmpeg.martin-riedl.de
set -e
PLATFORM="$1"; ARCH="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/$PLATFORM-$ARCH/ffmpeg"
EXT=""; [ "$PLATFORM" = "win32" ] && EXT=".exe"
if [ -f "$DEST/ffmpeg$EXT" ] && [ -f "$DEST/ffprobe$EXT" ]; then echo "ffmpeg already in $DEST"; exit 0; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"
case "$PLATFORM" in
  win32)
    VER="${FFMPEG_WIN_VERSION:-n9.0-latest-win64-lgpl-shared-9.0}"
    curl -fsSL -o "$TMP/ffmpeg.zip" "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-$VER.zip"
    unzip -q "$TMP/ffmpeg.zip" -d "$TMP/x"
    BIN="$(find "$TMP/x" -type d -name bin | head -1)"
    cp "$BIN/ffmpeg.exe" "$BIN/ffprobe.exe" "$BIN"/*.dll "$DEST/"
    LIC="$(find "$TMP/x" -maxdepth 2 -name 'LICENSE*' | head -1)"
    [ -n "$LIC" ] && cp "$LIC" "$DEST/LICENSE-ffmpeg.txt"
    ;;
  darwin)
    # static 9.0.2 builds from ffmpeg.martin-riedl.de
    case "$ARCH" in
      arm64) BASE="https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2" ;;
      x64)   BASE="https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2" ;;
      *) echo "unsupported arch $ARCH"; exit 1 ;;
    esac
    for tool in ffmpeg ffprobe; do
      curl -fsSL -o "$TMP/$tool.zip" "$BASE/$tool.zip"
      unzip -q -o "$TMP/$tool.zip" -d "$TMP/$tool"
      cp "$(find "$TMP/$tool" -type f -name "$tool" | head -1)" "$DEST/$tool"
      chmod +x "$DEST/$tool"
    done
    ;;
  *) echo "unsupported platform $PLATFORM"; exit 1 ;;
esac
echo "ffmpeg for $PLATFORM-$ARCH in $DEST"
