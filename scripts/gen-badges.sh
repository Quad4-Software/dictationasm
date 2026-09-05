#!/usr/bin/env bash
# Generate shields.io endpoint JSON badges from badges/theme.json.
# Reusable across Quad4 *asm apps. Run: make badges
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THEME="$ROOT/badges/theme.json"
OUT="$ROOT/badges"

if [[ ! -f "$THEME" ]]; then
  echo "missing $THEME" >&2
  exit 1
fi

mkdir -p "$OUT"

python3 - "$THEME" "$OUT" "$ROOT" <<'PY'
import json, os, re, sys
from pathlib import Path

theme_path, out_dir, root = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
theme = json.loads(theme_path.read_text(encoding="utf-8"))

label_color = theme["labelColor"].lstrip("#")
color = theme["color"].lstrip("#")
style = theme.get("style", "flat-square")
name = theme["name"]
repo = theme["repo"]
live = theme.get("live", "")
image = theme.get("image", "")
tagline = theme.get("tagline", "offline")

version = os.environ.get("VERSION", "").strip()
if not version:
    ver_go = root / "internal" / "version" / "version.go"
    text = ver_go.read_text(encoding="utf-8") if ver_go.exists() else ""
    m = re.search(r'Version\s*=\s*"([^"]+)"', text)
    version = m.group(1) if m else "0.0.0"

go_mod = (root / "go.mod").read_text(encoding="utf-8")
gm = re.search(r"(?m)^go\s+(\d+(?:\.\d+)*)", go_mod)
go_ver = gm.group(1) if gm else "1"

def write(name: str, payload: dict) -> None:
    payload.setdefault("schemaVersion", 1)
    payload.setdefault("labelColor", label_color)
    payload.setdefault("color", color)
    payload.setdefault("style", style)
    path = out_dir / name
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(root)}")

write("version.json", {
    "label": "version",
    "message": version if version.startswith("v") else f"v{version}",
    "namedLogo": "github",
    "logoColor": color,
})

write("license.json", {
    "label": "license",
    "message": theme.get("license", "0BSD"),
})

write("go.json", {
    "label": "go",
    "message": go_ver,
    "namedLogo": "go",
    "logoColor": color,
})

write("offline.json", {
    "label": "runs",
    "message": tagline,
})

if image:
    write("docker.json", {
        "label": "image",
        "message": image.split("/")[-1] if "/" in image else image,
        "namedLogo": "docker",
        "logoColor": color,
    })

if live:
    host = live.replace("https://", "").replace("http://", "").rstrip("/")
    write("live.json", {
        "label": "live",
        "message": host,
    })

openssf_msg = "scorecard"
try:
    import urllib.request
    req = urllib.request.Request(
        f"https://api.scorecard.dev/projects/github.com/{repo}",
        headers={"Accept": "application/json", "User-Agent": f"{name}-badges"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        score_data = json.load(resp)
    score = score_data.get("score")
    if isinstance(score, (int, float)):
        openssf_msg = f"{score:.1f}/10"
except Exception:
    pass

write("openssf.json", {
    "label": "openssf",
    "message": openssf_msg,
    "namedLogo": "openssf",
    "logoColor": color,
})

# Markdown snippet for README (shields endpoint + CI)
owner_repo = repo
raw = f"https://raw.githubusercontent.com/{owner_repo}/badges"
enc = __import__("urllib.parse").parse.quote

def endpoint(file: str) -> str:
    return f"https://img.shields.io/endpoint?url={enc(f'{raw}/{file}', safe='')}"

ci = (
    f"https://img.shields.io/github/actions/workflow/status/{owner_repo}/ci.yml"
    f"?branch=master&style={style}&label=ci&labelColor={label_color}&color={color}"
)

lines = [
    f'[![CI]({ci})](https://github.com/{owner_repo}/actions/workflows/ci.yml)',
    f'[![OpenSSF]({endpoint("openssf.json")})](https://scorecard.dev/viewer/?uri=github.com/{owner_repo})',
    f'[![version]({endpoint("version.json")})](https://github.com/{owner_repo}/releases)',
    f'[![license]({endpoint("license.json")})](https://github.com/{owner_repo}/blob/master/LICENSE)',
    f'[![go]({endpoint("go.json")})](https://go.dev/dl/)',
    f'[![offline]({endpoint("offline.json")})]({live or f"https://github.com/{owner_repo}"})',
]
if image:
    lines.append(
        f'[![docker]({endpoint("docker.json")})]'
        f'(https://github.com/orgs/{owner_repo.split("/")[0]}/packages/container/package/{name})'
    )
if live:
    lines.append(f'[![live]({endpoint("live.json")})]({live})')

snippet = out_dir / "README.snippet.md"
snippet.write_text(" ".join(lines) + "\n", encoding="utf-8")
print(f"wrote {snippet.relative_to(root)}")
PY
