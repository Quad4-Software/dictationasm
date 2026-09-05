#!/usr/bin/env bash
# Build Chrome CRX/ZIP and Firefox XPI into web/build for site + release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP="$(basename "$ROOT")"
DEFAULT_ORIGIN="https://${APP}.quad4.io"
SITE_ORIGIN="${SITE_ORIGIN:-$DEFAULT_ORIGIN}"
SITE_ORIGIN="${SITE_ORIGIN%/}"

VERSION="${VERSION:-}"
if [[ -z "$VERSION" ]]; then
  if [[ "${GITHUB_REF_TYPE:-}" == "tag" && "${GITHUB_REF_NAME:-}" == v* ]]; then
    VERSION="${GITHUB_REF_NAME#v}"
  elif git describe --tags --exact-match >/dev/null 2>&1; then
    VERSION="$(git describe --tags --exact-match | sed 's/^v//')"
  else
    VERSION="$(sed -n 's/^VERSION[[:space:]]*?=[[:space:]]*//p' Makefile | head -1 | tr -d '[:space:]')"
  fi
fi
VERSION="${VERSION:-0.0.0}"
if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]]; then
  VERSION="0.0.0"
fi

OUT="${OUT:-$ROOT/web/build}"
STAGE="$ROOT/.build/extensions"
if [[ -n "${EXTENSION_PEM:-}" && -f "${EXTENSION_PEM}" ]]; then
  KEY="$EXTENSION_PEM"
else
  KEY="$ROOT/extension/signing.pem"
fi
CHROME_SRC="$ROOT/extension/chrome"
FIREFOX_SRC="$ROOT/extension/firefox"
CHROME_ID_FILE="$ROOT/extension/chrome-id.txt"

mkdir -p "$OUT" "$STAGE"
rm -rf "$STAGE/chrome" "$STAGE/firefox"
cp -a "$CHROME_SRC" "$STAGE/chrome"
cp -a "$FIREFOX_SRC" "$STAGE/firefox"

stamp_manifests() {
  python3 - "$STAGE/chrome/manifest.json" "$STAGE/firefox/manifest.json" "$VERSION" "$SITE_ORIGIN" "$APP" <<'PY'
import json, sys
chrome_path, firefox_path, version, site_origin, app = sys.argv[1:6]

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def dump(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

chrome = load(chrome_path)
firefox = load(firefox_path)
chrome["version"] = version
firefox["version"] = version
chrome["update_url"] = f"{site_origin}/build/updates.xml"
gecko = firefox.setdefault("browser_specific_settings", {}).setdefault("gecko", {})
gecko["id"] = f"{app}@quad4.io"
gecko["update_url"] = f"{site_origin}/build/updates.json"

def rewrite_hosts(manifest):
    hosts = [
        f"{site_origin}/*",
        "http://127.0.0.1/*",
        "http://localhost/*",
    ]
    manifest["host_permissions"] = hosts
    ext = manifest.setdefault("externally_connectable", {})
    ext["matches"] = hosts

rewrite_hosts(chrome)
rewrite_hosts(firefox)
dump(chrome_path, chrome)
dump(firefox_path, firefox)
PY
}

stamp_manifests

if [[ ! -f "$KEY" ]]; then
  echo "missing signing key: $KEY" >&2
  echo "generate with: openssl genrsa -out extension/signing.pem 2048" >&2
  exit 1
fi

CHROME_ID="$(tr -d '[:space:]' < "$CHROME_ID_FILE" 2>/dev/null || true)"
if [[ -z "$CHROME_ID" ]]; then
  CHROME_ID="$(python3 - "$KEY" <<'PY'
import hashlib, subprocess, sys
der = subprocess.check_output(
    ["openssl", "rsa", "-in", sys.argv[1], "-pubout", "-outform", "DER"],
    stderr=subprocess.DEVNULL,
)
digest = hashlib.sha256(der).digest()[:16]
print("".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0x0F)) for b in digest))
PY
)"
  printf '%s\n' "$CHROME_ID" > "$CHROME_ID_FILE"
fi

CHROME_ZIP="$OUT/${APP}-chrome-${VERSION}.zip"
CHROME_CRX="$OUT/${APP}-chrome-${VERSION}.crx"
FIREFOX_XPI="$OUT/${APP}-firefox-${VERSION}.xpi"
LATEST_CHROME_ZIP="$OUT/${APP}-chrome.zip"
LATEST_CHROME_CRX="$OUT/${APP}-chrome.crx"
LATEST_FIREFOX_XPI="$OUT/${APP}-firefox.xpi"

rm -f "$CHROME_ZIP" "$CHROME_CRX" "$FIREFOX_XPI" \
  "$LATEST_CHROME_ZIP" "$LATEST_CHROME_CRX" "$LATEST_FIREFOX_XPI" \
  "$OUT/updates.xml" "$OUT/updates.json"

(
  cd "$STAGE/chrome"
  zip -qr -FS "$CHROME_ZIP" .
)
(
  cd "$STAGE/firefox"
  zip -qr -FS "$FIREFOX_XPI" .
)

pack_crx() {
  if command -v chromium >/dev/null 2>&1; then
    local pack_dir="$STAGE/chrome"
    local packed_crx="$STAGE/chrome.crx"
    rm -f "$packed_crx"
    chromium --headless=new --no-sandbox --disable-gpu \
      --pack-extension="$pack_dir" --pack-extension-key="$KEY" >/dev/null 2>&1 \
      || chromium --no-sandbox --disable-gpu \
        --pack-extension="$pack_dir" --pack-extension-key="$KEY"
    mv -f "$packed_crx" "$CHROME_CRX"
    return
  fi
  if command -v npx >/dev/null 2>&1; then
    npx --yes crx@5.0.1 pack "$STAGE/chrome" -o "$CHROME_CRX" -p "$KEY"
    return
  fi
  echo "need chromium or npx to build CRX" >&2
  exit 1
}

pack_crx

cp -f "$CHROME_ZIP" "$LATEST_CHROME_ZIP"
cp -f "$CHROME_CRX" "$LATEST_CHROME_CRX"
cp -f "$FIREFOX_XPI" "$LATEST_FIREFOX_XPI"

chmod a+r "$CHROME_ZIP" "$CHROME_CRX" "$FIREFOX_XPI" \
  "$LATEST_CHROME_ZIP" "$LATEST_CHROME_CRX" "$LATEST_FIREFOX_XPI"

# Chrome autoupdate XML + Firefox updates JSON
cat > "$OUT/updates.xml" <<EOF
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${CHROME_ID}'>
    <updatecheck codebase='${SITE_ORIGIN}/build/${APP}-chrome.crx' version='${VERSION}' />
  </app>
</gupdate>
EOF

python3 - "$OUT/updates.json" "$APP" "$VERSION" "$SITE_ORIGIN" <<'PY'
import json, sys
path, app, version, site = sys.argv[1:5]
data = {
  "addons": {
    f"{app}@quad4.io": {
      "updates": [
        {
          "version": version,
          "update_link": f"{site}/build/{app}-firefox.xpi",
        }
      ]
    }
  }
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

(
  cd "$OUT"
  sha256sum \
    "$(basename "$CHROME_ZIP")" \
    "$(basename "$CHROME_CRX")" \
    "$(basename "$FIREFOX_XPI")" \
    "$(basename "$LATEST_CHROME_ZIP")" \
    "$(basename "$LATEST_CHROME_CRX")" \
    "$(basename "$LATEST_FIREFOX_XPI")" \
    updates.xml \
    updates.json \
    > SHA256SUMS
)

python3 - "$OUT" "$APP" "$VERSION" "$SITE_ORIGIN" "$CHROME_ID" <<'PY'
import json, sys, datetime
from pathlib import Path
out, app, version, site, chrome_id = Path(sys.argv[1]), *sys.argv[2:]
meta = {
  "name": app,
  "version": version,
  "site_origin": site,
  "chrome_id": chrome_id,
  "firefox_id": f"{app}@quad4.io",
  "built_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "files": {
    "chrome_crx": f"{app}-chrome.crx",
    "chrome_zip": f"{app}-chrome.zip",
    "firefox_xpi": f"{app}-firefox.xpi",
    "chrome_crx_versioned": f"{app}-chrome-{version}.crx",
    "chrome_zip_versioned": f"{app}-chrome-{version}.zip",
    "firefox_xpi_versioned": f"{app}-firefox-{version}.xpi",
    "updates_chrome": "updates.xml",
    "updates_firefox": "updates.json",
    "checksums": "SHA256SUMS",
  },
}
(out / "manifest.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
PY

PAGE_TEMPLATE="$ROOT/extension/build-page.html"
if [[ -f "$PAGE_TEMPLATE" ]]; then
  sed -e "s/__APP__/${APP}/g" -e "s/__VERSION__/${VERSION}/g" "$PAGE_TEMPLATE" > "$OUT/index.html"
fi

chmod a+r "$OUT/updates.xml" "$OUT/updates.json" "$OUT/manifest.json" "$OUT/SHA256SUMS" "$OUT/index.html"

echo "built extensions into $OUT (version $VERSION, site $SITE_ORIGIN, chrome_id $CHROME_ID)"
ls -la "$OUT"
