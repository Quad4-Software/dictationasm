#!/usr/bin/env bash
# Install Playwright deps (once) and capture docs/screenshots.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/scripts/screenshot"

cd "$DIR"
if [[ ! -d node_modules/playwright ]]; then
	npm ci --no-fund --no-audit
fi

# Prefer system Chromium. Only download Playwright's browser when none found.
if [[ -z "${CHROMIUM_PATH:-}" ]]; then
	for c in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
		if [[ -x "$c" ]]; then
			export CHROMIUM_PATH="$c"
			break
		fi
	done
fi
if [[ -z "${CHROMIUM_PATH:-}" ]]; then
	npx playwright install chromium
fi

cd "$ROOT"
if [[ -z "${SCREENSHOT_BASE_URL:-}" && ! -x "$ROOT/bin/dictationasm" ]]; then
	make build
fi

exec node "$DIR/capture.mjs" "$@"
