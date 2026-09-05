#!/usr/bin/env bash
# Fetch the offline fonts used by the dictation UI into web/fonts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FONT_DIR="$ROOT/web/fonts"

mkdir -p "$FONT_DIR"

download() {
  local url="$1"
  local dest="$2"
  if [[ -f "$dest" && -s "$dest" ]]; then
    echo "present: $dest"
    return 0
  fi
  echo "fetching $url"
  curl -L --fail --retry 5 --retry-delay 2 -o "$dest" "$url"
}

download "https://cdn.jsdelivr.net/fontsource/fonts/syne@5.2.5/latin-700-normal.woff2" \
  "$FONT_DIR/syne-700.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/source-sans-3@5.2.5/latin-400-normal.woff2" \
  "$FONT_DIR/source-sans-400.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/source-sans-3@5.2.5/latin-600-normal.woff2" \
  "$FONT_DIR/source-sans-600.woff2"

echo "offline fonts ready"
