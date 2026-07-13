#!/usr/bin/env python3
"""Teacher-style quality judge for every LLM-written activity.

For each language/knowledge activity (math templates are deterministic and
skip the judge), a claude judge checks:
  1. Exactly ONE clearly-correct answer among the items.
  2. Distractors are plausible but fairly, unambiguously wrong.
  3. Reading level fits the grade; say-line is short, warm, no jargon.
  4. Fact accuracy for science/social/vocab.
Verdicts: keep | fix (returns corrected activity) | drop.
Rewrites the bank files in place. Resumable via _judged flags.
"""
import json, os, subprocess, sys
from pathlib import Path

WEB = Path.home() / "Documents/Brainforest/web/content"
CLAUDE = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
MODEL = os.environ.get("BF_JUDGE_MODEL", "sonnet")   # judging deserves the better model
LOG = lambda *a: print(*a, flush=True)

JUDGE_SKILLS = {"sight_words", "phonics_cvc", "math_shapes", "science", "sel", "social",
                "spell", "reading_comp", "vocab", "grammar", "math_word"}
GRADE_NAME = {"gK": "kindergarten (age 5)", "g1": "1st grade (age 6)", "g2": "2nd grade (age 7)",
              "g3": "3rd grade (age 8)", "g4": "4th grade (age 9)"}

def call_claude(prompt, timeout=240):
    env = os.environ.copy(); env.pop("ANTHROPIC_API_KEY", None)
    p = subprocess.run([CLAUDE, "--print", "--model", MODEL, prompt],
                       capture_output=True, text=True, timeout=timeout, env=env)
    txt = (p.stdout or "").strip()
    if txt.startswith("```"):
        txt = txt.split("```")[1]
        if txt.startswith("json"): txt = txt[4:]
    return txt.strip()

def valid(act):
    try:
        t = act["t"]; s = t["screen"]
        if not t["say"].strip(): return False
        items = s["items"]
        if len(items) < 2 or len(set(map(str, items))) != len(items): return False
        if str(s["answer"]) not in [str(i) for i in items]: return False
        return True
    except Exception:
        return False

def judge_bank(tag):
    path = WEB / f"bank_{tag}.json"
    if not path.exists():
        LOG(f"[{tag}] missing, skip"); return
    bank = json.loads(path.read_text())
    todo = [i for i, a in enumerate(bank)
            if a["skill"] in JUDGE_SKILLS and not a.get("_judged")]
    LOG(f"[{tag}] {len(todo)} activities to judge")
    kept = fixed = dropped = 0
    for chunk_start in range(0, len(todo), 8):
        idxs = todo[chunk_start:chunk_start + 8]
        batch = [{"n": j, "activity": bank[i]} for j, i in enumerate(idxs)]
        prompt = f"""You are a strict elementary-school curriculum reviewer for {GRADE_NAME[tag]}.
For EACH activity below, judge:
1. Is exactly one item clearly correct ("answer")? No other item may be arguably correct.
2. Are the wrong items plausible but fairly wrong (not tricky/ambiguous, not absurdly easy)?
3. Is the wording at this grade's reading level, short and warm? Kid answers by tapping.
4. Are science/social/vocab statements factually TRUE?

Reply ONLY with a JSON array, one element per activity:
{{"n": <n>, "verdict": "keep"}} OR
{{"n": <n>, "verdict": "fix", "activity": <corrected full activity, same schema>}} OR
{{"n": <n>, "verdict": "drop", "why": "<short reason>"}}
Use "fix" for salvageable issues (reword, swap a distractor). Use "drop" only if fundamentally broken.

ACTIVITIES:
{json.dumps(batch, ensure_ascii=False)}"""
        try:
            verdicts = json.loads(call_claude(prompt))
        except Exception as e:
            LOG(f"[{tag}] judge batch parse fail: {e}"); continue
        drop_set = set()
        for v in verdicts if isinstance(verdicts, list) else []:
            try:
                bank_i = idxs[int(v["n"])]
            except Exception:
                continue
            if v.get("verdict") == "fix" and isinstance(v.get("activity"), dict):
                cand = v["activity"]
                cand["_judged"] = True
                if valid(cand) and cand.get("skill") == bank[bank_i]["skill"]:
                    bank[bank_i] = cand; fixed += 1
                else:
                    bank[bank_i]["_judged"] = True; kept += 1   # bad fix — keep original
            elif v.get("verdict") == "drop":
                drop_set.add(bank_i); dropped += 1
            else:
                bank[bank_i]["_judged"] = True; kept += 1
        if drop_set:
            bank = [a for i, a in enumerate(bank) if i not in drop_set]
            todo = [i for i, a in enumerate(bank)
                    if a["skill"] in JUDGE_SKILLS and not a.get("_judged")]
        path.write_text(json.dumps(bank, ensure_ascii=False))
        LOG(f"[{tag}] progress: kept {kept} fixed {fixed} dropped {dropped}")
    LOG(f"[{tag}] DONE: kept {kept}, fixed {fixed}, dropped {dropped}, total now {len(bank)}")

if __name__ == "__main__":
    for tag in (sys.argv[1:] or ["gK", "g1", "g2", "g3", "g4"]):
        judge_bank(tag)
    LOG("JUDGE SWEEP DONE")
