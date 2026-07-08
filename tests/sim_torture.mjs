// Brainforest torture suite: long-horizon soak, garbage-input monkey,
// corruption recovery, store growth. Complements sim_engine.mjs.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const ENGINE = readFileSync(join(ROOT, "engine.js"), "utf8");

const localStore = {};
global.localStorage = {
  getItem: k => (k in localStore ? localStore[k] : null),
  setItem: (k, v) => { localStore[k] = String(v); },
  removeItem: k => { delete localStore[k]; },
};
global.document = { addEventListener: () => {}, visibilityState: "visible" };
global.window = global;
global.Response = class {
  constructor(body, init) { this._body = body; this.status = (init && init.status) || 200; this.ok = this.status < 300; }
  async json() { return JSON.parse(this._body); }
  async arrayBuffer() { return this._body; }
};
const diskFetch = async (path) => {
  try {
    const data = readFileSync(join(ROOT, String(path)));
    return { ok: true, status: 200, json: async () => JSON.parse(data.toString()) };
  } catch (e) { return { ok: false, status: 404, json: async () => { throw e; } }; }
};

let PASS = 0, FAIL = 0; const failures = [];
const check = (name, cond, detail) => {
  if (cond) PASS++; else { FAIL++; failures.push(name + (detail ? " — " + detail : "")); }
};

function bootEngine() {
  global.fetch = diskFetch;          // engine grabs this as realFetch
  (0, eval)(ENGINE);                 // fresh IIFE — rebinds window.fetch/BF
  return (method, path, body) =>
    window.fetch(path, { method, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
}

// =====================================================================
// A. CORRUPTION RECOVERY — engine must boot from any store garbage
// =====================================================================
const GARBAGE = ["{corrupt!!", "null", "[]", '"hi"', '{"kids":5}', '{"kids":[1,2]}',
  '{"kids":{},"kv":[]}', '{"kids":{"jane":{"prefs":null,"mastery":"x"}},"kv":{"kid":"jane","profiles":[{"id":"jane","display":"Jane","grade":1}]}}'];
for (const g of GARBAGE) {
  localStore["brainforest_store"] = g;
  let api;
  try {
    api = bootEngine();
    const kids = await api("GET", "/api/kids");
    const created = await api("POST", "/api/kid/create", { name: "Test", grade: 1 });
    const next = await api("POST", "/api/next", { history: [] });
    check(`corrupt store boots: ${g.slice(0, 24)}`,
      Array.isArray(kids.kids) && (created.ok || created.error) && (next.say || next.error),
      JSON.stringify(next).slice(0, 80));
  } catch (e) {
    check(`corrupt store boots: ${g.slice(0, 24)}`, false, String(e).slice(0, 100));
  }
  delete localStore["brainforest_store"];
}

// =====================================================================
// B. MONKEY — garbage bodies must never throw out of the fetch shim
// =====================================================================
{
  const api = bootEngine();
  await api("POST", "/api/kid/create", { name: "Monkey", grade: 3 });
  const paths = [
    ["POST", "/api/next"], ["POST", "/api/attempt"], ["POST", "/api/fact"],
    ["POST", "/api/grade"], ["POST", "/api/session/start"], ["POST", "/api/session/end"],
    ["POST", "/api/quest/complete"], ["POST", "/api/pref"], ["POST", "/api/kid/create"],
    ["GET", "/api/state"], ["GET", "/api/path"], ["GET", "/api/collection"],
  ];
  const bodies = [undefined, null, {}, [], 42, "string", { skill: null }, { history: "nope" },
    { history: [{ prompt: 12 }] }, { grade: -9 }, { grade: 99 }, { name: "x".repeat(500), grade: 2 },
    { correct: "yes", difficulty: "hard", theme: 7 }, { session_id: "abc" },
    { expected: null, got: undefined }, { theme: "🦄".repeat(100) }, { recent: 42 }, { skill: "💥" }];
  let thrown = 0, calls = 0;
  for (const [m, p] of paths) {
    for (const b of bodies) {
      calls++;
      try { await window.fetch(p, { method: m, body: JSON.stringify(b) }).then(r => r.json()); }
      catch (e) { thrown++; if (thrown === 1) failures.push("first monkey throw: " + m + " " + p + " body=" + JSON.stringify(b) + " -> " + e); }
    }
  }
  check(`monkey: ${calls} garbage calls, zero unhandled throws`, thrown === 0, `${thrown} threw`);
}

// =====================================================================
// C. LONG-HORIZON SOAK — one kid per grade, 1500 activities each
// =====================================================================
{
  delete localStore["brainforest_store"];   // isolate from monkey section
  const factGradesAvailable = new Set(JSON.parse(readFileSync(join(ROOT, "content/facts.json"), "utf8")).map(f => f.grade));
  const badSamples = [];
  const api = bootEngine();
  const kids = [];
  for (const [name, grade] of [["Ka", 0], ["Ona", 1], ["Two", 2], ["Tre", 3], ["Fou", 4]]) {
    const r = await api("POST", "/api/kid/create", { name, grade });
    kids.push({ id: r.kid.id, grade });
  }
  const t0 = Date.now();
  let served = 0, badSchema = 0, emptyFacts = 0, factCalls = 0;
  for (const kid of kids) {
    BF.kv.set("kid", kid.id);
    let history = [], sid = null, acts = 0;
    for (let i = 0; i < 1500; i++) {
      if (acts === 0) sid = (await api("POST", "/api/session/start", { theme: "space" })).session_id;
      const p = await api("POST", "/api/next", { history: history.slice(-8), theme: "space" });
      served++;
      const s = p.screen || {};
      // trace activities (writing_letter) legitimately have no items
      const isTap = p.expects !== "trace";
      const bad = !p.say || (isTap && (!Array.isArray(s.items) || !s.items.some(it => String(it) === String(s.answer))));
      if (bad) { badSchema++; if (badSamples.length < 3) badSamples.push(JSON.stringify(p).slice(0, 220)); }
      const correct = Math.random() < 0.75;
      await api("POST", "/api/attempt", { skill: p.skill, correct, difficulty: p.difficulty,
        prompt: s.title || "", expected: s.answer || "", got: correct ? s.answer : "x",
        theme: "space", session_id: sid, latency_ms: 1200 });
      history.push({ prompt: s.title, skill: p.skill, correct });
      acts++;
      if (i % 3 === 0 && factGradesAvailable.has(kid.grade + 1)) {
        factCalls++;
        const f = await api("POST", "/api/fact", {});
        if (!f.text) emptyFacts++;
      }
      if (acts >= 9) {
        await api("POST", "/api/quest/complete", { theme: "space" });
        await api("POST", "/api/session/end", { session_id: sid, seconds: 600, activities: acts });
        acts = 0; history = [];
      }
    }
    const m = await api("GET", "/api/mastery");
    const sane = m.mastery.every(x => x.score >= 0 && x.score <= 1 && x.tier >= 0 && x.tier <= 3);
    check(`soak g${kid.grade}: mastery scores/tiers in range`, sane);
  }
  const ms = Date.now() - t0;
  check("soak: 7500 activities schema-clean", badSchema === 0,
        `${badSchema} bad of ${served}; samples: ${badSamples.join(" ||| ")}`);
  check("soak: fast enough for a phone (<3ms/serve avg)", ms / served < 3, `${(ms / served).toFixed(2)}ms avg`);
  await new Promise(r => setTimeout(r, 600));
  const size = (localStore["brainforest_store"] || "").length;
  check("soak: store stays small after 7500 attempts (<2MB)", size < 2 * 1024 * 1024,
        `${(size / 1024).toFixed(0)}KB`);
  // K kid gets facts only if grade-1 facts exist yet; don't fail on that,
  // but grade 1/3 kids (fact grades 2/4) must never starve.
  check("soak: facts never starve when that grade's facts exist", emptyFacts === 0,
        `${emptyFacts}/${factCalls} empty`);
}

// =====================================================================
// D. RAPID-FIRE — double-taps / concurrent calls don't corrupt state
// =====================================================================
{
  delete localStore["brainforest_store"];   // isolate from soak section
  const api = bootEngine();
  const sp = await api("POST", "/api/kid/create", { name: "Speedy", grade: 1 });
  BF.kv.set("kid", sp.kid.id);
  const results = await Promise.all(Array.from({ length: 50 }, () =>
    window.fetch("/api/attempt", { method: "POST", body: JSON.stringify({ skill: "math_add", correct: true, theme: "cats" }) }).then(r => r.json())));
  check("rapid: 50 concurrent attempts all answered", results.every(r => r.ok), "");
  const m = await api("GET", "/api/mastery");
  const add = m.mastery.find(x => x.skill === "math_add");
  check("rapid: all 50 attempts recorded", add.attempts === 50, `got ${add.attempts}`);
  const col = await api("GET", "/api/collection");
  check("rapid: 50 stickers banked", col.total_stickers === 50, `got ${col.total_stickers}`);
}

console.log(`\n===== BRAINFOREST TORTURE SUITE =====`);
console.log(`PASS: ${PASS}   FAIL: ${FAIL}`);
if (failures.length) { console.log("FAILURES:"); failures.forEach(f => console.log("  ✘ " + f)); process.exit(1); }
console.log("ALL GREEN ✔");
