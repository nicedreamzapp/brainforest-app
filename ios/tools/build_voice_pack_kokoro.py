#!/usr/bin/env python3
"""Brainforest prerecorded narration pack — Kokoro edition.

Same phrase enumeration and key scheme as build_voice_pack.py, but synthesized
with Kokoro-82M (af_heart) instead of Piper. Warmer and more animated, and it is
Apache-2.0 so the clips can ship inside the app.

Run:  ~/JaneOS/.venv/bin/python3 build_voice_pack_kokoro.py
Resumable: existing clips are skipped.

Raw 24kHz wavs are kept in voice_raw/ so the pack can be pitched younger later
with a cheap ffmpeg pass instead of a full re-render.

Key normalization MUST mirror Swift Narrator.normalize(): trim, collapse
whitespace, lowercase. The KEY uses the exact string JS sends (emoji included);
the SPOKEN text has emoji stripped (they get read aloud by name otherwise).
"""
import hashlib, json, re, subprocess, sys, os
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
OUT = WEB / "voice"
RAW = WEB.parent / "voice_raw"
OUT.mkdir(exist_ok=True, parents=True)
RAW.mkdir(exist_ok=True, parents=True)
KOKORO_VOICE = os.environ.get("BF_VOICE", "af_heart")
APP_JS = (WEB / "app.js").read_text()
LOG = lambda *a: print(*a, flush=True)

EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF⬀-⯿️]")

# MUST mirror classifyQuestion() in app.js. If these two ever disagree, a line the
# app speaks will have no clip and drop to the robot voice mid-lesson.
INSTRUCTION_RE = re.compile(
    r"^(click|tap|find|pick|choose|drag|trace|say|type|write|spell|read|look|"
    r"count|figure out|calculate|solve|listen)\b", re.I)
EMOJI_PLACEHOLDER = re.compile(r"\{EMOJI\}", re.I)
WORD_RE = re.compile(r"[A-Za-z]{2,}")
STOPWORDS = set(("a an the is are was were do does did to of in on for that this these those "
                 "it its and or you your with what which how many much be been am i we they "
                 "he she").split())


def _is_heading(v):
    return not re.search(r"[.?!]\s*$", v) and len(WORD_RE.findall(v)) <= 6


def _rewords(a, b):
    setof = lambda t: set(w for w in re.findall(r"[a-z']+", (t or "").lower())
                          if w not in STOPWORDS)
    A, B = setof(a), setof(b)
    return bool(B) and len(A & B) / len(B) >= 0.8


def classify_question(say, title, prompt):
    """Returns (heading, context, ask) — mirrors classifyQuestion() in app.js."""
    heading = None
    cands = []
    for name, raw in (("say", say), ("title", title), ("prompt", prompt)):
        v = str(raw or "").strip()
        if not v:
            continue
        if (EMOJI_PLACEHOLDER.search(v) or len(WORD_RE.findall(v)) < 3
                or (name == "title" and _is_heading(v))):
            heading = heading or v
            continue
        cands.append(v)
    asks = [v for v in cands if v.rstrip().endswith("?")]
    ask = max(asks, key=len) if asks else None
    rest = [v for v in cands if v is not ask]
    if ask is None:
        prose = [v for v in rest if not INSTRUCTION_RE.match(v)]
        ask = (prose or rest or [None])[0]
        rest = [v for v in rest if v is not ask]
    context = next((v for v in rest
                    if not INSTRUCTION_RE.match(v) and not _rewords(v, ask)), None)
    return heading, context, ask

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
        # The spoken question is whatever the classifier calls context + ask —
        # the heading is decorative and never spoken, so it is never recorded.
        _, ctx, ask = classify_question(t.get("say"), s.get("title"), s.get("prompt"))
        for part in (ctx, ask):
            if part:
                add(tts_friendly(kidify(part)))
# 2. fixed phrase pools straight out of app.js (praise, try-again, hints)
for ph in extract_js_array("function pickPraise"): add(ph)
for ph in extract_js_array("function pickGentleTry"): add(ph)
try:
    for ph in extract_js_array("const TRY_AGAIN_HINTS"): add(ph)
except ValueError:
    LOG("note: TRY_AGAIN_HINTS not present in this app.js")
add("Take your time. Tap the answer when you're ready.")
add("Take your time. Click the answer when you're ready.")

# 3. greetings — split into pieces (matches the app's split-speak):
#    tiny name utterance + nameless quest/practice sentences + streak counts
# The name is the ONLY dynamic line in the whole app. Unrecorded, it dropped to
# the device synthesizer, so a kid heard the robot say their name and then the
# real voice take over mid-greeting. Record the common names, and app.js falls
# back to a plain recorded "Hi!" for anything not in this list — never the robot.
KID_NAMES = ['Aaliyah', 'Aaron', 'Abigail', 'Adam', 'Addison', 'Adeline', 'Adrian', 'Aiden', 'Alex', 'Alexis', 'Alice', 'Allison', 'Amanda', 'Amelia', 'Amir', 'Andrew', 'Angel', 'Anna', 'Anthony', 'Aria', 'Ariana', 'Arya', 'Asher', 'Ashley', 'Athena', 'Aubrey', 'Audrey', 'Aurora', 'Austin', 'Autumn', 'Ava', 'Avery', 'Axel', 'Beau', 'Bella', 'Ben', 'Benjamin', 'Bennett', 'Blake', 'Brandon', 'Brian', 'Brooklyn', 'Brooks', 'Bryson', 'Caleb', 'Cameron', 'Camila', 'Caroline', 'Carter', 'Charles', 'Charlie', 'Charlotte', 'Chloe', 'Christian', 'Christopher', 'Claire', 'Clara', 'Colton', 'Connor', 'Cooper', 'Cora', 'Damian', 'Daniel', 'David', 'Declan', 'Delilah', 'Dominic', 'Dylan', 'Eden', 'Eleanor', 'Elena', 'Eli', 'Eliana', 'Elias', 'Elijah', 'Elizabeth', 'Ella', 'Ellie', 'Elliot', 'Emerson', 'Emilia', 'Emily', 'Emma', 'Emmanuel', 'Emmett', 'Enzo', 'Eric', 'Esther', 'Ethan', 'Eva', 'Evelyn', 'Everett', 'Everly', 'Ezekiel', 'Ezra', 'Faith', 'Finley', 'Gabriel', 'Gabriella', 'Genesis', 'Gianna', 'Grace', 'Grayson', 'Gregory', 'Hailey', 'Hannah', 'Harper', 'Hayden', 'Hazel', 'Henry', 'Hudson', 'Ian', 'Iris', 'Isaac', 'Isabella', 'Isabelle', 'Isla', 'Ivy', 'Jace', 'Jack', 'Jackson', 'Jake', 'James', 'Jameson', 'Jane', 'Jasper', 'Jaxon', 'Jayce', 'Jayden', 'Jeffrey', 'Jenny', 'Jessica', 'Joe', 'John', 'Jonathan', 'Jordan', 'Jose', 'Josephine', 'Joshua', 'Josiah', 'Julia', 'Julian', 'June', 'Justin', 'Kai', 'Katherine', 'Katie', 'Kennedy', 'Kevin', 'Kinsley', 'Kylie', 'Landon', 'Laura', 'Layla', 'Leah', 'Leilani', 'Leo', 'Levi', 'Liam', 'Liliana', 'Lillian', 'Lily', 'Lincoln', 'Liv', 'Logan', 'Luca', 'Lucas', 'Lucy', 'Luke', 'Luna', 'Madison', 'Mary', 'Mason', 'Mateo', 'Matt', 'Matthew', 'Maverick', 'Max', 'Maya', 'Melanie', 'Melody', 'Mia', 'Micah', 'Michael', 'Michelle', 'Mila', 'Miles', 'Morgan', 'Naomi', 'Natalie', 'Nate', 'Nathan', 'Nevaeh', 'Nicholas', 'Nicole', 'Noah', 'Nolan', 'Nora', 'Nova', 'Oliver', 'Olivia', 'Owen', 'Paisley', 'Parker', 'Patrick', 'Penelope', 'Peyton', 'Piper', 'Quinn', 'Reagan', 'Rebecca', 'Remi', 'Riley', 'River', 'Roman', 'Rory', 'Rose', 'Rowan', 'Ruby', 'Ruth', 'Ryan', 'Ryder', 'Rylee', 'Sadie', 'Sam', 'Samuel', 'Santiago', 'Sarah', 'Savannah', 'Sawyer', 'Scarlett', 'Scott', 'Sean', 'Sebastian', 'Serenity', 'Sienna', 'Silas', 'Skylar', 'Sofia', 'Sophia', 'Sophie', 'Stella', 'Stephanie', 'Steven', 'Taylor', 'Theodore', 'Thomas', 'Timothy', 'Tom', 'Tyler', 'Valentina', 'Victoria', 'Vincent', 'Violet', 'Vivian', 'Waylon', 'Wesley', 'Weston', 'Will', 'William', 'Willow', 'Wyatt', 'Xavier', 'Zachary', 'Zack', 'Zoe', 'Zoey']
for nm in KID_NAMES:
    add(f"Hi {nm}!")
(OUT / "names.json").write_text(json.dumps(KID_NAMES))
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

if "--count-only" in sys.argv:
    sys.exit(0)

# ---------------- synthesize ----------------
try:
    import numpy as np, soundfile as sf
    from kokoro import KPipeline
except ImportError as e:
    sys.exit(f"run me with ~/JaneOS/.venv/bin/python3 (missing: {e})")

pipe = KPipeline(lang_code="a")
LOG(f"kokoro loaded, voice={KOKORO_VOICE}")

manifest_path = OUT / "manifest.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
done = skip = fail = 0
for js_string, spoken in phrases.items():
    k = key(js_string)
    fname = k + ".m4a"
    if manifest.get(k) == fname and (OUT / fname).exists():
        skip += 1; continue
    try:
        chunks = [a for _, _, a in pipe(spoken, voice=KOKORO_VOICE, speed=1.0)]
        if not chunks:
            fail += 1; continue
        audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        wav_path = RAW / (k + ".wav")
        sf.write(str(wav_path), audio, 24000)
        r = subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "32000",
                            str(wav_path), str(OUT / fname)], capture_output=True, timeout=60)
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
