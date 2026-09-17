#!/usr/bin/env python3
"""Fail the build if ANY line the app can speak has no recorded clip.

Since the synthesizer fallback was removed, a missing clip is silence — the kid
just gets nothing. Checking by hand is not a guarantee; this is. Both
build_and_upload.sh and install_to_phone.sh run it and refuse to proceed on a
non-zero exit.

Covers every source of spoken text:
  * question context + ask for all 2,039 activities (via the shared classifier)
  * "Remember this one? ..." comeback variants and "It was X." reveals
  * every answer-choice label
  * praise / gentle-try / retry-hint phrase pools straight out of app.js
  * greeting names in voice/names.json
  * quest, practice, streak, treasure and finale lines

Usage:  ~/JaneOS/.venv/bin/python3 tools/verify_voice_coverage.py
"""
import hashlib, importlib.util, io, contextlib, json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "web"

# Reuse the pack builder itself so the enumeration can never drift from what
# actually gets recorded. --count-only stops it before it synthesizes anything.
spec = importlib.util.spec_from_file_location("packbuilder", HERE / "build_voice_pack_kokoro.py")
mod = importlib.util.module_from_spec(spec)
_argv = sys.argv[:]
sys.argv = ["packbuilder", "--count-only"]
try:
    with contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(mod)
except SystemExit:
    pass
finally:
    sys.argv = _argv

manifest_path = WEB / "voice" / "manifest.json"
if not manifest_path.exists():
    sys.exit("VOICE COVERAGE FAILED: no voice/manifest.json — regenerate the pack.")
manifest = json.loads(manifest_path.read_text())


def key(t):
    return hashlib.md5(" ".join(str(t).strip().split()).lower().encode()).hexdigest()


missing = []
checked = 0

# 1. everything the pack builder enumerates (questions, options, reveals, quests…)
for js_string in mod.phrases:
    checked += 1
    k = key(js_string)
    if k not in manifest or not (WEB / "voice" / manifest[k]).exists():
        missing.append(js_string)

# 2. the phrase pools, read from app.js so a hand-edit can't slip past
app_js = (WEB / "app.js").read_text()
for marker in ("function pickPraise", "function pickGentleTry", "const TRY_AGAIN_HINTS"):
    if marker not in app_js:
        continue
    i = app_js.index(marker)
    j = app_js.index("];", i)
    for phrase in re.findall(r'"((?:[^"\\]|\\.)*)"', app_js[app_js.index("[", i):j]):
        checked += 1
        k = key(phrase)
        if k not in manifest or not (WEB / "voice" / manifest[k]).exists():
            missing.append(phrase)

# 3. greeting names — app.js only speaks a name that appears in this list
names_path = WEB / "voice" / "names.json"
if names_path.exists():
    for n in json.loads(names_path.read_text()):
        checked += 1
        k = key(f"Hi {n}!")
        if k not in manifest or not (WEB / "voice" / manifest[k]).exists():
            missing.append(f"Hi {n}!")

if missing:
    print(f"VOICE COVERAGE FAILED: {len(missing)} of {checked} spoken lines have no clip.")
    for m in missing[:25]:
        print(f"   MISSING: {m[:90]!r}")
    if len(missing) > 25:
        print(f"   … and {len(missing)-25} more")
    print("Regenerate:  ~/JaneOS/.venv/bin/python3 tools/build_voice_pack_kokoro.py")
    sys.exit(1)

print(f"voice coverage OK: {checked} spoken lines, every one has a clip on disk")
