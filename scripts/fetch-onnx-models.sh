#!/usr/bin/env bash
# Fetch Moonshine ONNX assets for in-browser dictation.
# WebGPU uses q4 encoder + q4 decoder. WASM uses q8 encoder + q8 decoder
# (falls back to fp32 encoder) when a dtype is unsupported.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ONNX_OUT:-$ROOT/web/models/onnx}"
HF="https://huggingface.co/onnx-community"

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

try_download() {
	local url="$1"
	local dest="$2"
	if [[ -f "$dest" && -s "$dest" ]]; then
		echo "present: $dest"
		return 0
	fi
	mkdir -p "$(dirname "$dest")"
	if curl -L --fail --retry 2 --retry-delay 1 -o "$dest" "$url"; then
		echo "fetched: $dest"
		return 0
	fi
	rm -f "$dest"
	echo "skip optional: $dest"
	return 0
}

fetch_model() {
	local id="$1"
	local dir="$OUT/$id"
	local base="$HF/$id/resolve/main"
	mkdir -p "$dir/onnx"

	download "$base/config.json" "$dir/config.json"
	download "$base/tokenizer.json" "$dir/tokenizer.json"
	download "$base/tokenizer_config.json" "$dir/tokenizer_config.json"
	download "$base/preprocessor_config.json" "$dir/preprocessor_config.json"
	download "$base/onnx/encoder_model.onnx" "$dir/onnx/encoder_model.onnx"
	download "$base/onnx/encoder_model_quantized.onnx" "$dir/onnx/encoder_model_quantized.onnx"
	download "$base/onnx/encoder_model_q4.onnx" "$dir/onnx/encoder_model_q4.onnx"
	download "$base/onnx/decoder_model_merged_q4.onnx" "$dir/onnx/decoder_model_merged_q4.onnx"
	download "$base/onnx/decoder_model_merged_quantized.onnx" "$dir/onnx/decoder_model_merged_quantized.onnx"

	try_download "$base/generation_config.json" "$dir/generation_config.json"
	try_download "$base/special_tokens_map.json" "$dir/special_tokens_map.json"
	try_download "$base/added_tokens.json" "$dir/added_tokens.json"
	try_download "$base/merges.txt" "$dir/merges.txt"
	try_download "$base/vocab.json" "$dir/vocab.json"
}

fetch_model "moonshine-tiny-ONNX"
fetch_model "moonshine-base-ONNX"

bash "$ROOT/scripts/fetch-vad.sh"

echo "moonshine onnx models ready"
