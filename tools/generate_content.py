#!/usr/bin/env python3
"""Brainforest content factory.

Builds bank_gK/g2/g4.json (+ facts for grades 1/3/5 merged into facts.json).
Math-type activities are generated deterministically (exact, no LLM errors);
language/science/social content comes from `claude --print` (Max plan), batch-
validated with the same rules the engine sim proved.

Resumable: each bank is written after every accepted batch.
"""
import json, os, random, re, subprocess, sys, time
from pathlib import Path

WEB = Path.home() / "Documents/Brainforest/web/content"
CLAUDE = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
MODEL = os.environ.get("BF_MODEL", "haiku")
LOG = lambda *a: print(*a, flush=True)

random.seed(20260706)

# ---------- validation (mirror of engine/_validate_activity + answer-in-items) ----------
def valid(act):
    if not isinstance(act, dict): return False
    t = act.get("t")
    if not isinstance(t, dict): return False
    if not isinstance(t.get("say"), str) or not t["say"].strip(): return False
    s = t.get("screen")
    if not isinstance(s, dict): return False
    if t.get("expects") not in ("tap", "trace"): return False
    if t["expects"] == "tap":
        items = s.get("items")
        if not isinstance(items, list) or len(items) < 2: return False
        if not all(isinstance(i, str) and i.strip() for i in items): return False
        if "answer" not in s: return False
        if str(s["answer"]) not in [str(i) for i in items]: return False
        if len(set(items)) != len(items): return False
    if not act.get("skill") or act["skill"] != t.get("skill"): return False
    try:
        d = int(act.get("difficulty", 0))
        if not (1 <= d <= 5): return False
    except Exception:
        return False
    return True

EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F600-\U0001F64F\U0001F680-\U0001F6FF]")

def A(skill, difficulty, say, stype, title, prompt, items, answer, extra=None):
    screen = {"type": stype, "title": title, "prompt": prompt,
              "items": [str(i) for i in items], "answer": str(answer)}
    if extra:
        screen.update(extra)   # visual data: clock={h,m} | coins=[[name,n]] | fractions=[[n,d]] | shape="star"
    return {"skill": skill, "difficulty": difficulty, "t": {
        "say": say, "screen": screen,
        "expects": "tap", "skill": skill, "difficulty": difficulty, "next_hint": ""}}

def opts(ans, lo, hi, n=4):
    """Answer + n-1 nearby distractors, shuffled, unique, within [lo,hi]."""
    pool = {ans}
    cand = [ans-1, ans+1, ans-2, ans+2, ans+3, ans-3, ans+10, ans-10]
    for c in cand:
        if len(pool) >= n: break
        if lo <= c <= hi and c != ans: pool.add(c)
    x = lo
    while len(pool) < n:
        if x not in pool: pool.add(x)
        x += 1
    out = sorted(pool)
    return [str(v) for v in out]

# ---------- deterministic math banks ----------
def math_K():
    out = []
    for n in range(1, 6):
        items = opts(n, 1, 5, 4)
        out.append(A("math_count", 1, "Count them and tap the right number!",
                     "image_word", "{EMOJI} " * n, "How many?", items, n))
    for n in range(6, 11):
        out.append(A("math_count", 2, "Count carefully and tap the right number!",
                     "image_word", "{EMOJI} " * n, "How many?", opts(n, 1, 12, 4), n))
    for a in range(1, 5):
        for b in range(1, 5):
            s = a + b
            if s > 8: continue
            d = 1 if s <= 5 else 2
            out.append(A("math_add", d, f"What is {a} plus {b}? Tap the answer!",
                         "math", f"{a} + {b} = ?", "Tap the answer!", opts(s, 0, 10), s))
    return out

def math_g2():
    out = []
    for a in range(3, 19):
        for b in range(2, 9):
            s = a + b
            if s > 20: continue
            out.append(A("math_add", 1, f"What is {a} plus {b}?", "math",
                         f"{a} + {b} = ?", "Tap the answer!", opts(s, 0, 25), s))
    for a in range(15, 50, 3):
        for b in (7, 12, 15, 21, 24):
            s = a + b
            if s > 50: continue
            out.append(A("math_add", 2, f"What is {a} plus {b}?", "math",
                         f"{a} + {b} = ?", "Tap the answer!", opts(s, 0, 60), s))
    for a in range(25, 100, 7):
        for b in (13, 24, 36, 45):
            s = a + b
            if s > 100: continue
            out.append(A("math_add", 3, f"What is {a} plus {b}?", "math",
                         f"{a} + {b} = ?", "Tap the answer!", opts(s, 0, 120), s))
    for a in range(5, 20):
        for b in range(2, min(a, 10)):
            out.append(A("math_sub", 1, f"What is {a} minus {b}?", "math",
                         f"{a} − {b} = ?", "Tap the answer!", opts(a-b, 0, 25), a-b))
    for a in range(20, 100, 6):
        for b in (7, 13, 18, 26):
            if b >= a: continue
            d = 2 if a <= 50 else 3
            out.append(A("math_sub", d, f"What is {a} minus {b}?", "math",
                         f"{a} − {b} = ?", "Tap the answer!", opts(a-b, 0, 110), a-b))
    for g in range(2, 6):
        for sz in range(2, 6):
            out.append(A("math_groups", 2, f"How many altogether? {g} groups of {sz}.",
                         "math", f"{g} groups of {sz}", "Tap the total!", opts(g*sz, 1, 30), g*sz))
    for start, step in [(2,2),(4,2),(5,5),(10,10),(3,3),(6,3),(4,4),(15,5),(20,10)]:
        seq = [start + step*i for i in range(4)]
        ans = seq[3]
        title = ", ".join(str(x) for x in seq[:3]) + ", ?"
        out.append(A("math_skip", 1 if step in (2,5,10) else 2,
                     "Skip count! What number comes next?", "math", title,
                     "Tap the missing number!", opts(ans, 1, ans+step*2), ans))
    for n in range(13, 100, 8):
        tens, ones = divmod(n, 10)
        right = f"{tens} tens {ones} ones"
        wrong = [f"{ones} tens {tens} ones", f"{n} tens", f"{n} ones",
                 f"{tens + 1} tens {ones} ones"]
        items = [right] + [w for w in wrong if w != right][:3]
        out.append(A("math_place_value", 2, f"What is {n} made of? Tap the right one.",
                     "math", str(n), "Tens and ones!", items, right))
    out += money_g2()
    out += time_g2()
    return out


VAL = {"quarter": 25, "dime": 10, "nickel": 5, "penny": 1}

def money_g2():
    """Money with REAL coin visuals (screen.coins drives SVG coins in the app)."""
    out = []
    combos = [
        ([("dime", 1), ("penny", 1)], 1), ([("dime", 2)], 1), ([("nickel", 1), ("penny", 2)], 1),
        ([("nickel", 2)], 1), ([("quarter", 1)], 1), ([("dime", 1), ("nickel", 2)], 2),
        ([("quarter", 1), ("dime", 1)], 2), ([("dime", 3), ("nickel", 1)], 2),
        ([("quarter", 1), ("penny", 2)], 2), ([("dime", 2), ("nickel", 1)], 2),
        ([("quarter", 1), ("dime", 1), ("penny", 1)], 2), ([("dime", 4)], 2),
        ([("quarter", 2)], 3), ([("quarter", 1), ("nickel", 1)], 2),
        ([("quarter", 2), ("dime", 2)], 3), ([("quarter", 3)], 3),
        ([("quarter", 1), ("dime", 2), ("nickel", 1)], 3),
    ]
    for coins, diff in combos:
        cents = sum(VAL[n] * c for n, c in coins)
        opts_ = [f"{v}¢" for v in dict.fromkeys([cents, cents + 5, max(1, cents - 5), cents + 10])][:4]
        out.append(A("money", diff, "Count the coins! How many cents is this?",
                     "math", "How much money?", "Count the coins!",
                     opts_, f"{cents}¢", extra={"coins": [[n, c] for n, c in coins]}))
    return out

def time_g2():
    """Telling time with a REAL clock face (screen.clock drives the SVG clock)."""
    out = []
    def tstr(h, m): return f"{h}:{m:02d}"
    def entry(h, m, diff, distractors):
        items = [tstr(h, m)] + distractors
        items = list(dict.fromkeys(items))[:4]
        return A("time", diff, "Look at the clock. What time is it?",
                 "math", "What time is it?", "Tap the right time!",
                 items, tstr(h, m), extra={"clock": {"h": h, "m": m}})
    for h in (1, 3, 5, 7, 9, 11, 12, 2):        # o'clock — difficulty 1
        out.append(entry(h, 0, 1, [tstr(h % 12 + 1, 0), tstr((h + 10) % 12 + 1, 0), tstr(h, 30)]))
    for h in (1, 4, 6, 8, 10, 12):              # half past — difficulty 2
        out.append(entry(h, 30, 2, [tstr(h, 0), tstr(h % 12 + 1, 30), tstr((h + 5) % 12 + 1, 0)]))
    for h in (2, 5, 7, 9):                      # quarter past / to — difficulty 2
        out.append(entry(h, 15, 2, [tstr(h, 45), tstr(h, 0), tstr(h % 12 + 1, 15)]))
        out.append(entry(h, 45, 2, [tstr(h, 15), tstr(h % 12 + 1, 45), tstr(h, 30)]))
    for h, m in [(3, 10), (6, 20), (8, 40), (11, 5), (1, 50), (4, 25)]:  # five-minute — difficulty 3
        out.append(entry(h, m, 3, [tstr(h, (m + 15) % 60), tstr(h % 12 + 1, m), tstr(h, (m + 30) % 60)]))
    return out

def shapes_K():
    """'What shape is this?' with a REAL drawn shape (screen.shape drives SVG)."""
    out = []
    shapes = ["circle", "square", "triangle", "rectangle", "star", "heart", "oval", "diamond"]
    for sh in shapes:
        others = random.sample([s for s in shapes if s != sh], 3)
        out.append(A("math_shapes", 1, "What shape is this? Tap its name!",
                     "word", "What shape is this?", "Tap the shape's name!",
                     sorted([sh] + others), sh, extra={"shape": sh}))
    sides = [("triangle", 3), ("square", 4), ("rectangle", 4), ("diamond", 4)]
    for sh, n in sides:
        out.append(A("math_shapes", 2, f"Count the sides! How many sides does this shape have?",
                     "math", "How many sides?", "Count the sides!",
                     [str(v) for v in dict.fromkeys([n, n - 1, n + 1, n + 2])][:4], str(n),
                     extra={"shape": sh}))
    return out

def fractions_g4_visual():
    """Fraction questions where the kid SEES the pies."""
    out = []
    # "What fraction is colored in?" — one pie, read it
    for num, den in [(1, 2), (1, 3), (2, 3), (1, 4), (3, 4), (2, 5), (5, 6), (3, 8)]:
        wrongs = [f"{den-num}/{den}", f"{num}/{den+1}", f"{min(num+1,den)}/{den}"]
        items = list(dict.fromkeys([f"{num}/{den}"] + wrongs))[:4]
        out.append(A("math_fractions", 2, "Look at the circle. What fraction is green?",
                     "math", "What fraction is green?", "Tap the fraction!",
                     items, f"{num}/{den}", extra={"fractions": [[num, den]]}))
    # compare two pies
    for a, b in [((1, 2), (1, 4)), ((2, 3), (1, 3)), ((3, 4), (1, 2)), ((1, 3), (1, 6)), ((5, 6), (1, 2))]:
        big = a if a[0] / a[1] > b[0] / b[1] else b
        out.append(A("math_fractions", 3, "Look at both circles. Which fraction is bigger?",
                     "math", "Which is bigger?", "Tap the bigger fraction!",
                     [f"{a[0]}/{a[1]}", f"{b[0]}/{b[1]}"], f"{big[0]}/{big[1]}",
                     extra={"fractions": [list(a), list(b)]}))
    return out

def math_g4():
    out = []
    for a in range(2, 13):
        for b in range(2, 13):
            d = 2 if max(a,b) <= 6 else (3 if max(a,b) <= 9 else 4)
            out.append(A("math_mult", d, f"What is {a} times {b}?", "math",
                         f"{a} × {b} = ?", "Tap the answer!", opts(a*b, 1, 160), a*b))
    for b in range(2, 13):
        for q in range(2, 13):
            a = b * q
            d = 3 if a <= 60 else 4
            out.append(A("math_div", d, f"What is {a} divided by {b}?", "math",
                         f"{a} ÷ {b} = ?", "Tap the answer!", opts(q, 1, 20), q))
    for a in range(13, 100, 9):
        for b in (3, 4, 6, 7):
            out.append(A("math_mult", 4, f"What is {a} times {b}?", "math",
                         f"{a} × {b} = ?", "Tap the answer!", opts(a*b, 10, a*b+40), a*b))
    fr_eq = [("1/2", "2/4"), ("1/3", "2/6"), ("1/4", "2/8"), ("2/3", "4/6"), ("1/2", "3/6"), ("3/4", "6/8")]
    for a, b in fr_eq:
        wrongs = [w for _, w in fr_eq if w != b][:3]
        out.append(A("math_fractions", 2, f"Which fraction equals {a}?", "math",
                     f"{a} = ?", "Tap the equal fraction!", [b]+wrongs, b))
    fr_cmp = [("1/2", "1/4", "1/2"), ("1/3", "1/2", "1/2"), ("3/4", "1/2", "3/4"),
              ("2/3", "1/3", "2/3"), ("1/4", "1/8", "1/4"), ("5/6", "1/2", "5/6")]
    for a, b, big in fr_cmp:
        out.append(A("math_fractions", 3, f"Which is bigger, {a} or {b}?", "math",
                     f"{a} or {b}", "Tap the bigger fraction!", [a, b], big))
    dec = [("0.5", "1/2"), ("0.25", "1/4"), ("0.75", "3/4"), ("0.1", "1/10"), ("0.2", "2/10")]
    for d_, f_ in dec:
        wrongs = [x for x, _ in dec if x != d_][:3]
        out.append(A("math_decimals", 3, f"Which decimal equals {f_}?", "math",
                     f"{f_} = ?", "Tap the matching decimal!", [d_]+wrongs, d_))
    for a, b in [(3,4),(5,2),(6,3),(7,4),(8,5),(9,2),(10,4),(12,3)]:
        area, per = a*b, 2*(a+b)
        out.append(A("math_geom", 3, f"A rectangle is {a} by {b}. What is its area?",
                     "math", f"{a} × {b} rectangle", "Tap the area!", opts(area, 1, 60), area))
        out.append(A("math_geom", 3, f"A rectangle is {a} by {b}. What is its perimeter?",
                     "math", f"{a} by {b} rectangle", "Tap the perimeter!", opts(per, 1, 60), per))
    return out

# ---------- deterministic letters (K) ----------
def letters_K():
    out = []
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for ch in alphabet:
        others = random.sample([c for c in alphabet if c != ch], 3)
        out.append(A("letters", 1, f"Tap the letter {ch}!", "word", "Find it!",
                     f"Which one is {ch}?", sorted([ch]+others), ch))
        out.append(A("letters", 2, f"Tap the small letter that matches big {ch}!",
                     "word", ch, "Find its small letter!",
                     sorted([ch.lower()] + [c.lower() for c in others]), ch.lower()))
    return out

# ---------- LLM generation ----------
def call_claude(prompt, timeout=180):
    env = os.environ.copy(); env.pop("ANTHROPIC_API_KEY", None)
    p = subprocess.run([CLAUDE, "--print", "--model", MODEL, prompt],
                       capture_output=True, text=True, timeout=timeout, env=env)
    txt = (p.stdout or "").strip()
    if txt.startswith("```"):
        txt = txt.split("```")[1]
        if txt.startswith("json"): txt = txt[4:]
    return txt.strip()

SCHEMA_NOTE = """Output ONLY a JSON array. Each element:
{"skill":"<skill>","difficulty":<1-5>,"t":{"say":"<spoken line, 1 short sentence, no emoji>",
 "screen":{"type":"<story|word|reading_comp|phonics|math>","title":"<see rules>",
 "prompt":"<short question/instruction>","items":["4 plain-string choices"],"answer":"<exactly one of items>"},
 "expects":"tap","skill":"<same skill>","difficulty":<same>,"next_hint":""}}
Rules: NO emoji anywhere. items are 4 UNIQUE plain strings, answer EXACTLY matches one item.
Never put the answer in the title or prompt. Kid answers by TAPPING only."""

LLM_JOBS = {
    "gK": [
        ("sight_words", 20, 1, "Pre-primer Dolch sight words for kindergarten (a, and, the, see, go, I, my, we, can, like...). type='word'. Title = the target word in CAPS, say='Tap the word that says \"<word>\".', items = word + 3 short distractor words, answer = the word lowercase."),
        ("phonics_cvc", 20, 1, "Kindergarten beginning-sound phonics. say='Tap the word that starts with the <X> sound.', type='phonics', title='<X>...', items = 4 simple CVC words, exactly one starting with that letter sound."),
        ("math_shapes", 14, 1, "Kindergarten shapes: circle, square, triangle, rectangle, star, heart. type='story'. Questions like 'Which shape has 3 sides?' items = shape names."),
        ("science", 16, 1, "Kindergarten science: animals, seasons, senses, day/night, weather. type='story', title = the question."),
        ("sel", 12, 1, "Kindergarten feelings and kindness questions. type='story'. Gentle, positive."),
    ],
    "g2": [
        ("sight_words", 24, 2, "2nd-grade Dolch/Fry sight words (because, always, around, thought...). type='word', title = word in CAPS, items = word + 3 distractors, answer lowercase."),
        ("spell", 20, 2, "2nd-grade spelling: say='Tap the correct spelling of <word>.', type='word', title='Spell it!', items = correct spelling + 3 plausible misspellings."),
        ("reading_comp", 20, 2, "2nd-grade reading: title = ONE short sentence or two (a tiny story), prompt = a comprehension question, type='reading_comp', 4 answer choices."),
        ("science", 20, 2, "2nd-grade science: life cycles, habitats, matter, weather, plants. type='story'."),
        ("social", 20, 2, "2nd-grade social studies: community helpers, maps, holidays, good citizenship. type='story'."),
    ],
    "g4": [
        ("math_word", 24, 3, "4th-grade one-step and two-step word problems (multiplication, division, money, time). type='math', title = the word problem (1-2 sentences), items = 4 numeric choices."),
        ("reading_comp", 24, 3, "4th-grade reading comprehension: title = a 2-3 sentence passage, prompt = an inference or main-idea question, type='reading_comp'."),
        ("vocab", 24, 3, "4th-grade vocabulary: synonyms, antonyms, definitions, context. type='word'."),
        ("spell", 20, 3, "4th-grade spelling: correct spelling vs 3 plausible misspellings. type='word', title='Spell it!'."),
        ("grammar", 20, 3, "4th-grade grammar: parts of speech, verb tense, punctuation, plurals. type='story'."),
        ("science", 20, 3, "4th-grade science: energy, ecosystems, water cycle, human body, electricity, space. type='story'."),
        ("social", 20, 3, "4th-grade social studies: US regions, government branches, famous Americans, geography. type='story'."),
    ],
}

def llm_bank(skill, count, difficulty, brief, grade_name, existing_titles):
    got, tries = [], 0
    while len(got) < count and tries < 6:
        tries += 1
        n = min(12, count - len(got) + 2)
        prompt = f"""You are generating activities for a kids' learning app ({grade_name}).
Generate {n} DIFFERENT activities for skill "{skill}" at difficulty {difficulty}.
{brief}
Avoid these existing titles: {sorted(existing_titles)[:40]}
{SCHEMA_NOTE}"""
        try:
            arr = json.loads(call_claude(prompt))
        except Exception as e:
            LOG(f"  [llm {skill}] parse fail try {tries}: {e}"); continue
        if not isinstance(arr, list): continue
        for act in arr:
            try:
                if isinstance(act, dict) and "t" in act:
                    act["skill"] = skill; act["t"]["skill"] = skill
                    act["difficulty"] = int(act.get("difficulty", difficulty))
                    act["t"]["difficulty"] = act["difficulty"]
                    act["t"]["expects"] = "tap"
                    act["t"]["say"] = EMOJI_RE.sub("", str(act["t"].get("say",""))).strip()
                    title = str(act["t"]["screen"].get("title",""))
                    if valid(act) and title not in existing_titles:
                        got.append(act); existing_titles.add(title)
                        if len(got) >= count: break
            except Exception:
                continue
        LOG(f"  [llm {skill}] {len(got)}/{count} after try {tries}")
    return got

def build_bank(tag, det_fn, grade_name):
    path = WEB / f"bank_{tag}.json"
    det = det_fn()
    if path.exists():
        existing = json.loads(path.read_text())
        if len(existing) > len(det):   # already finished (det base + LLM extras)
            LOG(f"[{tag}] already complete ({len(existing)}), skipping")
            return existing
    bank = det
    for a in bank:
        assert valid(a), f"deterministic invalid: {json.dumps(a)[:200]}"
    titles = {a["t"]["screen"]["title"] for a in bank}
    path.write_text(json.dumps(bank, ensure_ascii=False))
    LOG(f"[{tag}] deterministic base: {len(bank)}")
    for skill, count, diff, brief in LLM_JOBS[tag]:
        bank += llm_bank(skill, count, diff, brief, grade_name, titles)
        path.write_text(json.dumps(bank, ensure_ascii=False))
        LOG(f"[{tag}] total {len(bank)} after {skill}")
    LOG(f"[{tag}] DONE: {len(bank)} activities -> {path}")
    return bank

# ---------- facts for grades 1, 3, 5 ----------
FACT_CATS = ["math", "science", "space", "animals", "geography", "body", "language", "history", "money"]
def build_facts():
    path = WEB / "facts.json"
    facts = json.loads(path.read_text())
    have = {(f["grade"], f["text"]) for f in facts}
    for grade in (1, 3, 5):
        per_cat = 12
        for cat in FACT_CATS:
            tries = 0
            got = 0
            while got < per_cat and tries < 4:
                tries += 1
                prompt = f"""Generate {per_cat + 3} fun "did you know" facts for a grade-{grade} kid, category "{cat}".
Output ONLY a JSON array: [{{"grade":{grade},"category":"{cat}","text":"Did you know ...? <one short kid-friendly sentence>","short":"<tiny on-screen version, max 30 chars>"}}]
No emoji. True, verifiable, kid-appropriate facts. Start each text with "Did you know"."""
                try:
                    arr = json.loads(call_claude(prompt))
                except Exception as e:
                    LOG(f"  [facts g{grade}/{cat}] parse fail: {e}"); continue
                for f in arr if isinstance(arr, list) else []:
                    if (isinstance(f, dict) and f.get("text") and f.get("short")
                            and (grade, f["text"]) not in have):
                        facts.append({"grade": grade, "category": cat,
                                      "text": EMOJI_RE.sub("", f["text"]).strip(),
                                      "short": str(f["short"])[:40]})
                        have.add((grade, f["text"])); got += 1
                        if got >= per_cat: break
            path.write_text(json.dumps(facts, ensure_ascii=False))
            LOG(f"[facts] g{grade}/{cat}: +{got} (total {len(facts)})")
    LOG(f"[facts] DONE: {len(facts)}")

if __name__ == "__main__":
    t0 = time.time()
    build_bank("gK", lambda: math_K() + letters_K(), "kindergarten, age 5")
    build_bank("g2", math_g2, "2nd grade, age 7")
    build_bank("g4", math_g4, "4th grade, age 9")
    build_facts()
    LOG(f"ALL CONTENT DONE in {int(time.time()-t0)}s")
