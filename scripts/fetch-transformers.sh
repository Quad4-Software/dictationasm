#!/usr/bin/env bash
# Vendor transformers.js + ORT wasm bits for offline WebGPU.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/vendor/transformers"
VER="${TRANSFORMERS_JS_VERSION:-3.7.2}"
BASE="https://cdn.jsdelivr.net/npm/@huggingface/transformers@${VER}/dist"

mkdir -p "$OUT"

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

download "$BASE/transformers.min.js" "$OUT/transformers.min.js"
download "$BASE/ort-wasm-simd-threaded.jsep.mjs" "$OUT/ort-wasm-simd-threaded.jsep.mjs"
download "$BASE/ort-wasm-simd-threaded.jsep.wasm" "$OUT/ort-wasm-simd-threaded.jsep.wasm"

echo "transformers vendor ready"
ls -lh "$OUT"
