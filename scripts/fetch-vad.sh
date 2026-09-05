#!/usr/bin/env bash
# Fetch the Silero voice-activity ONNX model used to commit utterances.
# The upstream repo ships no config.json, the browser passes a custom config inline.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ONNX_OUT:-$ROOT/web/models/onnx}/silero-vad"
BASE="https://huggingface.co/onnx-community/silero-vad/resolve/main"

download() {
	local url="$1"
	local dest="$2"
	if [[ -f "$dest" && -s "$dest" ]]; then
		echo "present: $dest"
		return 0
	fi
	mkdir -p "$(dirname "$dest")"
	echo "fetching $url"
	curl -L --fail --retry 5 --retry-delay 2 -o "$dest" "$url"
}

download "$BASE/onnx/model.onnx" "$OUT/onnx/model.onnx"
download "$BASE/LICENSE" "$OUT/LICENSE"

echo "silero vad ready"
