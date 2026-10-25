#!/usr/bin/env python3
"""Brainforest prerecorded narration pack.

Enumerates every phrase the app can speak, synthesizes with the JaneOS Piper
voice (Amy — the voice the kids already know), compresses to mono AAC m4a via
afconvert, and writes web/voice/manifest.json {md5(normalized_text): filename}.

Run with the JaneOS venv python:  ~/JaneOS/.venv/bin/python3 build_voice_pack.py
Resumable: existing clips are skipped.

Key normalization MUST mirror Swift Narrator.normalize(): trim, collapse
whitespace, lowercase. The KEY uses the exact string JS sends (emoji included);
the SPOKEN text has emoji stripped (they sound bad in TTS).
"""
import hashlib, json, re, subprocess, sys, tempfile, os
from pathlib import Path

WEB = Path.home() / "Documents/Brainforest/web"
OUT = WEB / "voice"
OUT.mkdir(exist_ok=True)
VOICE_FILE = Path.home() / "JaneOS/voices" / os.environ.get("BF_VOICE", "en_US-hfc_female-medium.onnx")
APP_JS = (WEB / "app.js").read_text()
LOG = lambda *a: print(*a, flush=True)

EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF⬀-⯿️]")

def kidify(t):   # phone build: Click -> Tap (mirrors _kidify with IS_TOUCH)
    return re.sub(r"\bCLICK\b", "TAP", re.sub(r"\bclick\b", "tap", re.sub(r"\bClick\b", "Tap", t)))

def tts_friendly(t):  # mirrors ttsFriendly(): UPPERCASE words -> Titlecase
    return re.sub(r"\b[A-Z]{2,}\b", lambda m: m.group(0)[0] + m.group(0)[1:].lower(), t)

def normalize(t):  # mirrors Swift Narrator.normalize()
    return " ".join(str(t).strip().split()).lower()

def key(t):
    return hashlib.md5(normalize(t).encode()).hexdigest()

def extract_js_array(func_marker):
    """Pull the string literals out of a JS array that follows a marker."""
    i = APP_JS.index(func_marker)
    seg = APP_JS[i:i + 12000]
    open_i = seg.index("[")
    depth, j = 0, open_i
    while j < len(seg):
        if seg[j] == "[": depth += 1
        elif seg[j] == "]":
            depth -= 1
            if depth == 0: break
        j += 1
    body = seg[open_i:j + 1]
    return re.findall(r'"((?:[^"\\]|\\.)*)"', body)

# ---------------- enumerate every speakable phrase ----------------
phrases = {}   # exact JS string -> spoken text

def add(js_string, spoken=None):
    js_string = str(js_string)
    if not js_string.strip(): return
    sp = EMOJI_RE.sub("", spoken if spoken is not None else js_string).strip()
    if not sp: return
    phrases.setdefault(js_string, sp)

THEME_PRETTY = {"unicorns": "unicorn", "mermaids": "mermaid", "dinos": "dinosaur",
                "space": "space", "cats": "kitty cat", "horses": "horse", "bluey": "puppy"}
TREASURES = ["Golden Key", "Rainbow Gem", "Royal Crown", "Champion Cup", "Explorer Compass",
             "Magic Wand", "Crystal Ball", "Pearl Shell", "Treasure Map", "Hero Medal",
             "Lucky Coin", "Brave Shield", "Ancient Scroll", "Glow Lantern", "Victory Trumpet",
             "Sparkle Ring", "Captain's Anchor", "Silver Bell"]
CURRICULUM_LABELS = ["Counting", "Adding", "Taking Away", "Groups Of", "Sounding Out", "Sight Words",
    "Science", "Big Feelings", "First Adding", "Shapes", "Letters", "First Sounds", "First Words",
    "Big Adding", "Big Take-Away", "Skip Counting", "Place Value", "Money", "Telling Time",
    "Reading", "Spelling", "Our World", "Multiplying", "Dividing", "Big Subtracting",
    "Fractions", "Word Problems", "Vocabulary", "Big Multiplying", "Long Division",
    "Decimals", "Geometry", "Grammar"]

# 1. bank content: say lines, comeback variants, answers, option labels
for bank_file in sorted(WEB.glob("content/bank_*.json")):
    for a in json.loads(bank_file.read_text()):
        t = a["t"]; s = t["screen"]
        say = tts_friendly(kidify(t["say"]))
        add(say)
        add(tts_friendly("Remember this one? " + kidify(t["say"])))
        if "answer" in s:
            add(tts_friendly(f"It was {s['answer']}."))
        for item in s.get("items", []):
            add(str(item))

# 2. fixed phrase pools straight out of app.js (praise, try-again, hints)
for ph in extract_js_array("function pickPraise"): add(ph)
for ph in extract_js_array("function pickGentleTry"): add(ph)
for ph in extract_js_array("const TRY_AGAIN_HINTS"): add(ph)
add("Take your time. Tap the answer when you're ready.")
add("Take your time. Click the answer when you're ready.")

# 3. greetings — split into pieces (matches the app's split-speak):
#    tiny name utterance + nameless quest/practice sentences + streak counts
for hi in ["Hi Jane!", "Hi Liv!", "Hi!"]:
    add(hi)
for steps in (6, 8, 9, 10):
    for tp in THEME_PRETTY.values():
        add(f"A new treehouse quest! Answer {steps} questions to climb to the top of the {tp} treehouse!")
for label in CURRICULUM_LABELS:
    for tp in THEME_PRETTY.values():
        add(f"Let's practice {label} in the {tp} world!")
for days in range(2, 31):
    add(f"{days} days in a row!")

# 4. finale + streak-bonus lines for every treasure
for name in TREASURES + ["a treasure"]:
    add(f"You did it! You climbed all the way to the top of the treehouse! You earned the {name}!")
for name in TREASURES:
    add(f"You earned the {name} for playing so many days in a row! It's in your sticker book!")

# 5. spoken facts (grade-1 kids hear grade-2 facts aloud)
facts = json.loads((WEB / "content/facts.json").read_text())
for f in facts:
    if f.get("grade") == 2:
        add("Did you know? " + f["text"])

LOG(f"{len(phrases)} unique phrases to record")

# ---------------- synthesize ----------------
try:
    from piper.voice import PiperVoice
except ImportError:
    sys.exit("run me with ~/JaneOS/.venv/bin/python3 (piper not in this python)")

import wave
voice = PiperVoice.load(str(VOICE_FILE))
LOG(f"piper loaded: {VOICE_FILE.name}")

manifest_path = OUT / "manifest.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
done = skip = fail = 0
for js_string, spoken in phrases.items():
    k = key(js_string)
    fname = k + ".m4a"
    if manifest.get(k) == fname and (OUT / fname).exists():
        skip += 1; continue
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            wav_path = tf.name
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(voice.config.sample_rate)
            voice.synthesize_wav(spoken, w)
        r = subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "32000",
                            wav_path, str(OUT / fname)], capture_output=True, timeout=60)
        os.unlink(wav_path)
        if r.returncode != 0:
            fail += 1; continue
        manifest[k] = fname
        done += 1
        if done % 200 == 0:
            manifest_path.write_text(json.dumps(manifest))
            LOG(f"  {done} recorded, {skip} cached, {fail} failed")
    except Exception as e:
        fail += 1
        if fail < 5: LOG(f"  fail on {spoken[:60]!r}: {e}")

manifest_path.write_text(json.dumps(manifest))
total_mb = sum(f.stat().st_size for f in OUT.glob("*.m4a")) / 1e6
LOG(f"VOICE PACK DONE: {done} new, {skip} cached, {fail} failed, {len(manifest)} clips, {total_mb:.1f}MB")
