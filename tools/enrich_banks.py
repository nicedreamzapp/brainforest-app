#!/usr/bin/env python3
"""Upgrade existing bank files in place with teaching-visual activities:
clock faces (time), real coins (money), fraction pies (g4), drawn shapes (K).
Safe to re-run any time; idempotent."""
import json
import generate_content as gc

def load(tag):
    p = gc.WEB / f"bank_{tag}.json"
    return (p, json.loads(p.read_text())) if p.exists() else (p, None)

def save(p, bank):
    for a in bank:
        assert gc.valid(a), f"invalid after enrich: {json.dumps(a)[:200]}"
    p.write_text(json.dumps(bank, ensure_ascii=False))

def swap(bank, skill, new_entries, keep=lambda a: False):
    """Remove old entries for `skill` (unless keep(a)), append the new ones."""
    kept = [a for a in bank if a["skill"] != skill or keep(a)]
    titles = {a["t"]["screen"]["title"] for a in kept}
    added = [a for a in new_entries if a["t"]["screen"]["title"] not in titles
             or a["t"]["screen"].get("clock") or a["t"]["screen"].get("coins")
             or a["t"]["screen"].get("fractions") or a["t"]["screen"].get("shape")]
    return kept + added

# g2: visual time + money
p, g2 = load("g2")
if g2:
    before = len(g2)
    g2 = [a for a in g2 if a["skill"] not in ("time", "money")]
    g2 += gc.time_g2() + gc.money_g2()
    save(p, g2)
    print(f"g2: {before} -> {len(g2)} (visual time+money)")

# gK: drawn shapes (keep the LLM 'which shape has N sides' text questions)
p, gk = load("gK")
if gk:
    before = len(gk)
    have_visual = any(a["t"]["screen"].get("shape") for a in gk)
    if not have_visual:
        gk += gc.shapes_K()
    save(p, gk)
    print(f"gK: {before} -> {len(gk)} (drawn shapes)")

# g4: fraction pies (replace the text-only deterministic fraction entries)
p, g4 = load("g4")
if g4:
    before = len(g4)
    g4 = [a for a in g4 if not (a["skill"] == "math_fractions" and not a["t"]["screen"].get("fractions"))]
    g4 += gc.fractions_g4_visual()
    save(p, g4)
    print(f"g4: {before} -> {len(g4)} (fraction pies)")
else:
    print("g4: not generated yet — run me again after the factory finishes")
