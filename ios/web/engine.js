/* Brainforest on-device engine — full port of the JaneOS server (server.py).
   Replaces every /api/* endpoint with local logic + persistent on-device storage.
   Loads BEFORE app.js and intercepts window.fetch for "/api/..." URLs.

   Persistence: native iOS bridge (window.webkit.messageHandlers.bfStore) writes
   Documents/brainforest_store.json; the app injects it back at launch as
   window.__BF_STORE. In a plain browser (testing) it falls back to localStorage.

   TTS: native bridge (bfTTS -> AVSpeechSynthesizer). Browser fallback returns a
   silent WAV so app.js's audio pipeline still sequences correctly in tests. */

(function () {
  "use strict";

  // ---- Grade configs (K = 0 through 4th grade) ----
  // capsStyle "early" = add/sub/groups caps (K-2); "upper" = mult/div caps (3-4).
  const ALL_THEMES = ["unicorns", "mermaids", "dinos", "space", "cats", "horses", "bluey"];
  const GRADES = {
    0: { label: "K",  capsStyle: "early", activity_seconds: 60,  quest_steps: 6,  fact_grade: 1, tutor_name: "Sprout" },
    1: { label: "1st", capsStyle: "early", activity_seconds: 75,  quest_steps: 8,  fact_grade: 2, tutor_name: "Bloom" },
    2: { label: "2nd", capsStyle: "early", activity_seconds: 100, quest_steps: 9,  fact_grade: 3, tutor_name: "Fern" },
    3: { label: "3rd", capsStyle: "upper", activity_seconds: 150, quest_steps: 10, fact_grade: 4, tutor_name: "Sage" },
    4: { label: "4th", capsStyle: "upper", activity_seconds: 180, quest_steps: 10, fact_grade: 5, tutor_name: "Rowan" },
  };

  // ---- Kid profiles ----
  // The app ships with NO preloaded kids — every family adds their own from
  // the picker (name + grade). Matt's girls get added on first launch.
  const DEFAULT_KID = null;

  function profiles() {
    if (!Array.isArray(STORE.kv.profiles)) STORE.kv.profiles = [];
    return STORE.kv.profiles;
  }
  function kidFromProfile(p) {
    const g = GRADES[p.grade] || GRADES[1];
    return {
      ...p, name: p.display, grade_label: g.label,
      tutor_name: p.tutor_name || g.tutor_name, fact_grade: g.fact_grade,
      themes: p.themes || ALL_THEMES,
      activity_seconds: g.activity_seconds, quest_steps: g.quest_steps,
      capsStyle: g.capsStyle,
    };
  }
  function KIDS_all() {
    const out = {};
    for (const p of profiles()) out[p.id] = kidFromProfile(p);
    return out;
  }

  // ---- Adaptive difficulty tiers (port of TIER_CAPS, extended to K-4) ----
  // Grade 1 and 3 rows are byte-for-byte the server's; K/2/4 follow the same
  // "start easier than grade level, climb only on proven mastery" directive.
  const TIER_CAPS = {
    0: [
      { band: [1, 1], max_num: 5,  add_sum: 5,  add_addend: 3, sub_minuend: 5,  groups_total: 4 },
      { band: [1, 1], max_num: 8,  add_sum: 8,  add_addend: 5, sub_minuend: 6,  groups_total: 4 },
      { band: [1, 2], max_num: 10, add_sum: 10, add_addend: 5, sub_minuend: 8,  groups_total: 6 },
      { band: [1, 2], max_num: 12, add_sum: 12, add_addend: 6, sub_minuend: 10, groups_total: 9 },
    ],
    1: [
      { band: [1, 1], max_num: 8,  add_sum: 8,  add_addend: 5,  sub_minuend: 6,  groups_total: 4 },
      { band: [1, 2], max_num: 12, add_sum: 10, add_addend: 6,  sub_minuend: 10, groups_total: 9 },
      { band: [1, 2], max_num: 15, add_sum: 15, add_addend: 9,  sub_minuend: 12, groups_total: 9 },
      { band: [2, 3], max_num: 20, add_sum: 20, add_addend: 10, sub_minuend: 20, groups_total: 12 },
    ],
    2: [
      { band: [1, 2], max_num: 20,  add_sum: 20,  add_addend: 10, sub_minuend: 20,  groups_total: 10 },
      { band: [2, 3], max_num: 50,  add_sum: 50,  add_addend: 25, sub_minuend: 50,  groups_total: 16 },
      { band: [2, 3], max_num: 100, add_sum: 100, add_addend: 50, sub_minuend: 100, groups_total: 25 },
      { band: [3, 4], max_num: 120, add_sum: 120, add_addend: 60, sub_minuend: 120, groups_total: 30 },
    ],
    3: [
      { band: [2, 3], mult_factor: 3,  addsub_operand: 20,  div_within: 20 },
      { band: [3, 3], mult_factor: 5,  addsub_operand: 50,  div_within: 50 },
      { band: [3, 4], mult_factor: 9,  addsub_operand: 100, div_within: 100 },
      { band: [3, 5], mult_factor: 12, addsub_operand: 200, div_within: 144 },
    ],
    4: [
      { band: [2, 3], mult_factor: 6,  addsub_operand: 100,   div_within: 50 },
      { band: [3, 4], mult_factor: 9,  addsub_operand: 500,   div_within: 100 },
      { band: [3, 4], mult_factor: 12, addsub_operand: 1000,  div_within: 144 },
      { band: [4, 5], mult_factor: 15, addsub_operand: 10000, div_within: 1000 },
    ],
  };

  function tierFromMastery(m) {
    if (!m) return 0;
    const s = m.score, a = m.attempts;
    if (s < 0.45 && a >= 6) return 0;
    // A kid who is acing a subject climbs about twice as fast.
    if (s >= 0.85 && a >= 60) return 3;
    if (s >= 0.92 && a >= 25) return 3;
    if (s >= 0.85 && a >= 30) return 2;
    if (s >= 0.92 && a >= 14) return 2;
    if (s >= 0.80 && a >= 12) return 1;
    if (s >= 0.92 && a >= 6) return 1;
    return 0;
  }

  // ---- Collection pools (port of STICKER_POOLS + TREASURES) ----
  const STICKER_POOLS = {
    unicorns: ["🦄", "🌈", "✨", "🌸", "🪄", "💖"],
    mermaids: ["🧜‍♀️", "🐚", "🐬", "🫧", "⭐", "🪸"],
    dinos:    ["🦕", "🦖", "🌋", "🥚", "🦴", "🌿"],
    space:    ["🚀", "🌟", "🪐", "👩‍🚀", "☄️", "🌙"],
    cats:     ["🐱", "🐾", "🧶", "🐟", "😺", "🎀"],
    horses:   ["🐴", "🍎", "🏇", "🌾", "🥕", "🐎"],
    bluey:    ["🐶", "🦴", "🎾", "🏠", "💙", "🧡"],
    default:  ["⭐", "✨", "🌈", "🎉", "💎", "🏅"],
  };
  const TREASURES = [
    ["🗝️", "Golden Key"], ["💎", "Rainbow Gem"], ["👑", "Royal Crown"],
    ["🏆", "Champion Cup"], ["🧭", "Explorer Compass"], ["🪄", "Magic Wand"],
    ["🔮", "Crystal Ball"], ["🐚", "Pearl Shell"], ["🗺️", "Treasure Map"],
    ["🎖️", "Hero Medal"], ["🪙", "Lucky Coin"], ["🛡️", "Brave Shield"],
    ["📜", "Ancient Scroll"], ["🏮", "Glow Lantern"], ["🎺", "Victory Trumpet"],
    ["💍", "Sparkle Ring"], ["⚓", "Captain's Anchor"], ["🔔", "Silver Bell"],
  ];

  // ---- Learning Path curriculum (port of PATH_CURRICULUM, extended K-4) ----
  const PATH_CURRICULUM = {
    0: [
      { key: "math_count",  label: "Counting",      emoji: "🔢", group: "Number Land", level: 1 },
      { key: "math_add",    label: "First Adding",  emoji: "➕", group: "Number Land", level: 2 },
      { key: "math_shapes", label: "Shapes",        emoji: "🔷", group: "Number Land", level: 1 },
      { key: "letters",     label: "Letters",       emoji: "🔠", group: "Word World",  level: 1 },
      { key: "phonics_cvc", label: "First Sounds",  emoji: "🔤", group: "Word World",  level: 2 },
      { key: "sight_words", label: "First Words",   emoji: "👀", group: "Word World",  level: 2 },
      { key: "science",     label: "Science",       emoji: "🔬", group: "Big Wide World", level: 1 },
      { key: "sel",         label: "Big Feelings",  emoji: "💗", group: "Big Wide World", level: 1 },
    ],
    2: [
      { key: "math_add",         label: "Big Adding",     emoji: "➕", group: "Number Land", level: 1 },
      { key: "math_sub",         label: "Big Take-Away",  emoji: "➖", group: "Number Land", level: 1 },
      { key: "math_groups",      label: "Groups Of",      emoji: "🍇", group: "Number Land", level: 2 },
      { key: "math_skip",        label: "Skip Counting",  emoji: "🦘", group: "Number Land", level: 1 },
      { key: "math_place_value", label: "Place Value",    emoji: "🏯", group: "Number Land", level: 2 },
      { key: "money",            label: "Money",          emoji: "🪙", group: "Number Land", level: 2 },
      { key: "time",             label: "Telling Time",   emoji: "🕒", group: "Number Land", level: 2 },
      { key: "reading_comp",     label: "Reading",        emoji: "📖", group: "Word World",  level: 2 },
      { key: "sight_words",      label: "Sight Words",    emoji: "👀", group: "Word World",  level: 1 },
      { key: "spell",            label: "Spelling",       emoji: "✏️", group: "Word World",  level: 2 },
      { key: "science",          label: "Science",        emoji: "🔬", group: "Big Wide World", level: 1 },
      { key: "social",           label: "Our World",      emoji: "🌎", group: "Big Wide World", level: 1 },
    ],
    4: [
      { key: "math_mult",      label: "Big Multiplying", emoji: "✖️", group: "Number Land", level: 1 },
      { key: "math_div",       label: "Long Division",   emoji: "➗", group: "Number Land", level: 2 },
      { key: "math_fractions", label: "Fractions",       emoji: "🍕", group: "Number Land", level: 2 },
      { key: "math_decimals",  label: "Decimals",        emoji: "🔟", group: "Number Land", level: 3 },
      { key: "math_word",      label: "Word Problems",   emoji: "🧩", group: "Number Land", level: 3 },
      { key: "math_geom",      label: "Geometry",        emoji: "📐", group: "Number Land", level: 2 },
      { key: "reading_comp",   label: "Reading",         emoji: "📖", group: "Word World",  level: 1 },
      { key: "vocab",          label: "Vocabulary",      emoji: "💬", group: "Word World",  level: 2 },
      { key: "spell",          label: "Spelling",        emoji: "✏️", group: "Word World",  level: 2 },
      { key: "grammar",        label: "Grammar",         emoji: "📝", group: "Word World",  level: 3 },
      { key: "science",        label: "Science",         emoji: "🔬", group: "Big Wide World", level: 1 },
      { key: "social",         label: "Our World",       emoji: "🌎", group: "Big Wide World", level: 1 },
    ],
    1: [
      { key: "math_count",  label: "Counting",     emoji: "🔢", group: "Number Land", level: 1 },
      { key: "math_add",    label: "Adding",        emoji: "➕", group: "Number Land", level: 1 },
      { key: "math_sub",    label: "Taking Away",   emoji: "➖", group: "Number Land", level: 2 },
      { key: "math_groups", label: "Groups Of",     emoji: "🍇", group: "Number Land", level: 2 },
      { key: "phonics_cvc", label: "Sounding Out",  emoji: "🔤", group: "Word World",  level: 1 },
      { key: "sight_words", label: "Sight Words",   emoji: "👀", group: "Word World",  level: 2 },
      { key: "science",     label: "Science",       emoji: "🔬", group: "Big Wide World", level: 1 },
      { key: "sel",         label: "Big Feelings",  emoji: "💗", group: "Big Wide World", level: 1 },
    ],
    3: [
      { key: "math_mult",        label: "Multiplying",    emoji: "✖️", group: "Number Land", level: 1 },
      { key: "math_div",         label: "Dividing",       emoji: "➗", group: "Number Land", level: 2 },
      { key: "math_add",         label: "Big Adding",     emoji: "➕", group: "Number Land", level: 1 },
      { key: "math_sub",         label: "Big Subtracting", emoji: "➖", group: "Number Land", level: 1 },
      { key: "math_place_value", label: "Place Value",    emoji: "🏯", group: "Number Land", level: 2 },
      { key: "math_fractions",   label: "Fractions",      emoji: "🍕", group: "Number Land", level: 3 },
      { key: "math_word",        label: "Word Problems",  emoji: "🧩", group: "Number Land", level: 3 },
      { key: "math_geom",        label: "Shapes",         emoji: "📐", group: "Number Land", level: 2 },
      { key: "reading_comp",     label: "Reading",        emoji: "📖", group: "Word World",  level: 2 },
      { key: "sight_words",      label: "Sight Words",    emoji: "👀", group: "Word World",  level: 1 },
      { key: "vocab",            label: "Vocabulary",     emoji: "💬", group: "Word World",  level: 2 },
      { key: "spell",            label: "Spelling",       emoji: "✏️", group: "Word World",  level: 2 },
      { key: "science",          label: "Science",        emoji: "🔬", group: "Big Wide World", level: 1 },
      { key: "social",           label: "Our World",      emoji: "🌎", group: "Big Wide World", level: 1 },
    ],
  };
  const MASTERED_AT = 0.85;

  const THEMES = ["unicorns", "mermaids", "dinos", "space", "cats", "horses", "bluey"];
  const THEME_EMOJI = { unicorns: "🦄", mermaids: "🧜‍♀️", dinos: "🦕",
                        space: "🚀", cats: "🐱", horses: "🐴", bluey: "🐶" };

  // Grab the real fetch BEFORE anything uses it (content loads at startup).
  const realFetch = window.fetch.bind(window);

  // ---- Persistent store ----
  // Shape: { kids: { jane: {prefs, mastery, attempts, sessions, collection, factsShown}, liv: {...} }, kv: {} }
  const nativeStore = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bfStore;
  const nativeTTS   = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bfTTS;

  function blankKidDB(kid) {
    return {
      prefs: { name: kid.display, tutor_name: kid.tutor_name, themes: JSON.stringify(kid.themes) },
      mastery: {},           // skill -> {score, attempts, correct, last_seen}
      attempts: [],          // capped ring of recent attempts
      sessions: [],          // capped
      collection: [],        // {ts, kind, item, name, theme} — forever
      factsShown: [],        // capped list of fact texts
    };
  }

  let STORE = null;
  function loadStore() {
    // The native shell injects the store it read when the app LAUNCHED, and
    // re-injects that same snapshot on every page load (index <-> parent
    // dashboard). Loading it blindly rolled progress back to launch time, and
    // the next save wrote the rollback to disk. Take whichever copy is newer.
    const injected = window.__BF_STORE;
    let local = null;
    try { local = JSON.parse(localStorage.getItem("brainforest_store") || "null"); } catch (_) { local = null; }
    const savedAt = (x) => (x && typeof x === "object" && Number(x.savedAt)) || 0;
    let raw = injected || local;
    if (injected && local && savedAt(local) > savedAt(injected)) raw = local;
    // Hardened: a corrupt/partial store file must never brick the engine.
    const sane = raw && typeof raw === "object"
      && raw.kids && typeof raw.kids === "object" && !Array.isArray(raw.kids);
    STORE = sane ? raw : { kids: {}, kv: {} };
    if (!STORE.kv || typeof STORE.kv !== "object" || Array.isArray(STORE.kv)) STORE.kv = {};
    for (const p of profiles()) {
      const kid = kidFromProfile(p);
      if (!STORE.kids[kid.id]) STORE.kids[kid.id] = blankKidDB(kid);
      const db = STORE.kids[kid.id];
      // forward-compat: fill any missing sections
      const blank = blankKidDB(kid);
      for (const k of Object.keys(blank)) if (db[k] === undefined) db[k] = blank[k];
    }
  }
  loadStore();
  // Leaving the page (parent dashboard and back) must not drop the last 400ms.
  window.addEventListener("pagehide", () => persist(true));

  let _saveTimer = null;
  function persist(immediate) {
    clearTimeout(_saveTimer);
    const doSave = () => {
      STORE.savedAt = Date.now();
      const json = JSON.stringify(STORE);
      try { localStorage.setItem("brainforest_store", json); } catch (_) {}
      if (nativeStore) { try { nativeStore.postMessage(json); } catch (_) {} }
    };
    if (immediate) doSave();
    else _saveTimer = setTimeout(doSave, 400);
  }

  // ---- KV (replaces cookies + localStorage flags in app.js) ----
  const BFKV = {
    get(k) { return STORE.kv[k] !== undefined ? STORE.kv[k] : null; },
    set(k, v) { STORE.kv[k] = v; persist(); },
  };

  // ---- Content (per-grade banks + facts + pre-generated packs) ----
  const CONTENT = { bank: {}, facts: [] };
  const GRADE_FILE = { 0: "gK", 1: "g1", 2: "g2", 3: "g3", 4: "g4" };
  const ready = (async function loadContent() {
    async function j(path) {
      const r = await realFetch(path);
      if (!r.ok) throw new Error(path + " -> " + r.status);
      return r.json();
    }
    CONTENT.facts = await j("content/facts.json").catch(() => []);
    for (const g of Object.keys(GRADE_FILE)) {
      const tag = GRADE_FILE[g];
      const bank = await j(`content/bank_${tag}.json`).catch(() => null);
      const pack = await j(`content/pack_${tag}.json`).catch(() => null);
      if (bank || pack) {
        // Drop exact duplicates (1st grade carried the "10 - n" set twice) and
        // give every question a stable id so recent ones can be skipped.
        const seen = new Set();
        CONTENT.bank[g] = (bank || []).concat(pack || []).filter(a => {
          // Same question with a different spoken intro or difficulty label is
          // still the same question to a kid.
          const sc = (a.t && a.t.screen) || {};
          const k = [a.skill, sc.title, sc.prompt, sc.answer, (sc.items || []).join("|")].join("~");
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        CONTENT.bank[g].forEach((a, i) => { a.id = Number(g) * 10000 + i; });
      }
    }
    console.log("[engine] content loaded:",
      Object.keys(CONTENT.bank).map(g => `g${g}:${CONTENT.bank[g].length}`).join(" "),
      "facts:", CONTENT.facts.length);
  })();

  // Nearest-grade fallback so a K/2/4 profile still gets sane content even if
  // that grade's bank file is missing from the bundle.
  function bankForGrade(grade) {
    if (CONTENT.bank[grade] && CONTENT.bank[grade].length) return CONTENT.bank[grade];
    const have = Object.keys(CONTENT.bank).map(Number);
    if (!have.length) return [];
    const nearest = have.sort((a, b) => Math.abs(a - grade) - Math.abs(b - grade) || a - b)[0];
    return CONTENT.bank[nearest];
  }

  // ---- Helpers ----
  const nowISO = () => new Date().toISOString();
  const localDateISO = (d) => {
    const x = d || new Date();
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  };
  const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const cap = (arr, n) => { while (arr.length > n) arr.shift(); };

  function currentKid() {
    const all = KIDS_all();
    const k = String(BFKV.get("kid") || "").toLowerCase();
    return all[k] || Object.values(all)[0] || null;
  }
  const kidDB = (kid) => STORE.kids[kid.id];

  function getPref(kid, key, dflt) {
    const v = kidDB(kid).prefs[key];
    return v === undefined || v === null ? (dflt === undefined ? null : dflt) : v;
  }
  function setPref(kid, key, value) { kidDB(kid).prefs[key] = value; persist(); }

  function masterySummary(kid) {
    const m = kidDB(kid).mastery;
    return Object.keys(m).map(skill => ({
      skill,
      score: Math.round(m[skill].score * 1000) / 1000,
      attempts: m[skill].attempts,
      correct: m[skill].correct,
      last_seen: m[skill].last_seen,
      tier: tierFromMastery(m[skill]),
    })).sort((a, b) => a.score - b.score);
  }

  function skillTiers(kid) {
    const out = {};
    for (const m of masterySummary(kid)) out[m.skill] = tierFromMastery({ score: m.score, attempts: m.attempts });
    return out;
  }

  function tierCaps(kid, skill, tiers) {
    const table = TIER_CAPS[kid.grade] || TIER_CAPS[1];
    tiers = tiers || skillTiers(kid);
    let t;
    if (skill) t = tiers[skill] || 0;
    else {
      const vals = Object.values(tiers);
      t = vals.length ? Math.min(...vals) : 0;
    }
    return table[Math.max(0, Math.min(t, table.length - 1))];
  }

  function recordAttempt(kid, body) {
    const db = kidDB(kid);
    const correct = !!body.correct;
    db.attempts.push({
      ts: nowISO(), session_id: body.session_id || null, skill: body.skill,
      difficulty: body.difficulty || 1, prompt: body.prompt || "",
      expected: body.expected || "", got: body.got || "",
      correct: correct ? 1 : 0, latency_ms: body.latency_ms || 0, theme: body.theme || null,
    });
    cap(db.attempts, 500);
    // mastery_correct = right on the FIRST try; one question moves mastery once.
    const firstTry = body.mastery_correct === undefined ? correct : !!body.mastery_correct;
    const alpha = 0.25, target = firstTry ? 1.0 : 0.0;
    const m = db.mastery[body.skill];
    if (!m) {
      db.mastery[body.skill] = { score: target, attempts: 1, correct: firstTry ? 1 : 0, last_seen: nowISO() };
    } else {
      m.score = m.score + alpha * (target - m.score);
      m.attempts += 1;
      m.correct += firstTry ? 1 : 0;
      m.last_seen = nowISO();
    }
    persist();
  }

  function awardSticker(kid, theme) {
    const pool = STICKER_POOLS[theme || ""] || STICKER_POOLS.default;
    const item = choice(pool);
    kidDB(kid).collection.push({ ts: nowISO(), kind: "sticker", item, name: null, theme: theme || null });
    persist();
    return item;
  }

  function awardTreasure(kid, theme) {
    const owned = new Set(kidDB(kid).collection.filter(c => c.kind === "treasure").map(c => c.name));
    const unowned = TREASURES.filter(t => !owned.has(t[1]));
    const [emoji, name] = choice(unowned.length ? unowned : TREASURES);
    kidDB(kid).collection.push({ ts: nowISO(), kind: "treasure", item: emoji, name, theme: theme || null });
    persist();
    return { emoji, name };
  }

  function collectionSummary(kid) {
    const col = kidDB(kid).collection;
    const sCount = {};
    for (const c of col) if (c.kind === "sticker") sCount[c.item] = (sCount[c.item] || 0) + 1;
    const stickers = Object.keys(sCount).map(item => ({ item, count: sCount[item] }))
      .sort((a, b) => b.count - a.count);
    const tMap = {};
    for (const c of col) if (c.kind === "treasure") {
      const k = c.item + " " + c.name;
      if (!tMap[k]) tMap[k] = { emoji: c.item, name: c.name, count: 0, ts: c.ts };
      tMap[k].count += 1;
      if (c.ts > tMap[k].ts) tMap[k].ts = c.ts;
    }
    const treasures = Object.values(tMap).sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .map(t => ({ emoji: t.emoji, name: t.name, count: t.count }));
    const total_stickers = col.filter(c => c.kind === "sticker").length;
    return { stickers, treasures, total_stickers };
  }

  // ---- Tier caps content filter (port of _within_caps) ----
  function withinCaps(kid, tiers, p) {
    const scr = p.screen || {};
    const title = String(scr.title || "");
    const prompt = String(scr.prompt || "");
    const items = scr.items || [];
    const skill = String(p.skill || "").toLowerCase();
    const caps = tierCaps(kid, p.skill, tiers);
    const haystack = [title, prompt, ...items.map(String), String(scr.answer || "")].join(" ");
    const nums = (haystack.match(/-?\d+/g) || []).map(Number);
    const intsInTitle = (title.match(/-?\d+/g) || []).map(Number);

    // Clock times, coin values, and place-value digits are labels, not
    // arithmetic magnitudes — exempt them from the raw number-size sweep.
    const NUM_EXEMPT = skill === "time" || skill === "money" || skill.includes("place");
    if (kid.capsStyle === "early") {
      if (!NUM_EXEMPT && nums.length && Math.max(...nums.map(Math.abs)) > caps.max_num) return false;
      if ((skill.includes("add") || title.includes("+")) && intsInTitle.length >= 2) {
        if (Math.max(intsInTitle[0], intsInTitle[1]) > caps.add_addend) return false;
        if (intsInTitle[0] + intsInTitle[1] > caps.add_sum) return false;
      }
      if ((skill.includes("sub") || title.includes("−") || title.includes(" - ")) && intsInTitle.length >= 2) {
        if (intsInTitle[0] > caps.sub_minuend) return false;
      }
      if (skill.includes("group") && intsInTitle.length >= 2) {
        if (intsInTitle[0] * intsInTitle[1] > caps.groups_total) return false;
      }
      return true;
    }
    if (kid.capsStyle === "upper") {
      if ((skill.includes("mult") || title.includes("×") || title.toLowerCase().includes(" x ")) && intsInTitle.length >= 2) {
        const f = kid.grade >= 4 ? Math.min : Math.max;   // 4th grade: 94 × 6 is a starter
        if (f(Math.abs(intsInTitle[0]), Math.abs(intsInTitle[1])) > caps.mult_factor) return false;
      }
      if ((skill.includes("div") || title.includes("÷")) && intsInTitle.length) {
        if (Math.abs(intsInTitle[0]) > caps.div_within) return false;
      }
      if ((skill.includes("add") || skill.includes("sub")) && intsInTitle.length >= 2) {
        if (Math.max(Math.abs(intsInTitle[0]), Math.abs(intsInTitle[1])) > caps.addsub_operand) return false;
      }
      return true;
    }
    return true;
  }

  // ---- Bank serving ----
  // Skill is the one filter that never relaxes: an island asked for Fractions
  // must get fractions. Difficulty, caps and "not seen lately" relax in that
  // order when a skill's pool is small.
  function bankServe(kid, opts) {
    const { skill, theme, band, predicate, recentIds } = opts;
    const grade = opts.grade != null ? opts.grade : kid.grade;
    const all = bankForGrade(grade);
    let pool = skill ? all.filter(a => a.skill === skill) : all;
    // A skill with only a few questions in this grade (4th-grade spelling had
    // ONE) borrows the same skill from the grades on either side.
    const ENOUGH = 6;
    if (skill && pool.length < ENOUGH) {
      for (const g of [grade - 1, grade + 1]) {
        if (CONTENT.bank[g] && CONTENT.bank[g] !== all) pool = pool.concat(CONTENT.bank[g].filter(a => a.skill === skill));
      }
    }
    if (!pool.length) pool = all;
    // A pool of one or two means the same question over and over, so the
    // difficulty band and number caps only apply when they leave enough to
    // rotate; otherwise widen to the nearest difficulties.
    if (band) {
      const dist = a => a.difficulty < band[0] ? band[0] - a.difficulty
                      : a.difficulty > band[1] ? a.difficulty - band[1] : 0;
      const maxD = Math.max(0, ...pool.map(dist));
      for (let d = 0; d <= maxD; d++) {
        const near = pool.filter(a => dist(a) <= d);
        if (near.length >= ENOUGH || d === maxD) { pool = near; break; }
      }
    }
    if (predicate) {
      const capped = pool.filter(a => predicate(a.t));
      if (capped.length >= ENOUGH) pool = capped;
    }
    // Skip everything served recently; if that empties a small pool, skip only
    // the most recent half, then quarter... so the oldest-seen comes back first.
    const recent = recentIds || [];
    for (let n = recent.length; n > 0; n = Math.floor(n / 2)) {
      const ex = new Set(recent.slice(recent.length - n));
      const fresh = pool.filter(a => !ex.has(a.id));
      if (fresh.length) { pool = fresh; break; }
    }
    const a = choice(pool);
    const out = JSON.parse(JSON.stringify(a.t));
    out.bank_id = a.id;
    spreadNumberChoices(out.screen || {}, out.skill, out.say);
    const th = theme || choice(THEMES);
    out.screen.theme = th;
    const title = out.screen.title || "";
    if (title.includes("{EMOJI}")) out.screen.title = title.split("{EMOJI}").join(THEME_EMOJI[th]).trim();
    out.next_hint = "";
    return out;
  }

  // The banks write number choices with a fixed shape: answer-2, answer-1,
  // answer, answer+1 (so "tap the second biggest" was right ~95% of the time),
  // or "common mistake" sets like answer-10, answer-9, answer-1 (answer always
  // biggest). Re-place the answer so its rank among the choices is uniform.
  // Only computed answers: a "which is biggest?" answer depends on the choices.
  const SPREAD_SKILLS = new Set(["math_count", "math_add", "math_sub", "math_mult", "math_div",
    "math_groups", "math_skip", "math_geom", "math_word", "money"]);
  const CHOICE_DEPENDENT = /bigg|small|great|least|most|more|less|fewer|odd|even|which|compare|order|round|closest/i;
  function spreadNumberChoices(scr, skill, say) {
    if (!SPREAD_SKILLS.has(skill)) return;
    if (CHOICE_DEPENDENT.test([scr.title, scr.prompt, scr.heading, say].join(" "))) return;
    const items = scr.items;
    if (!Array.isArray(items) || items.length < 3) return;
    // Money choices carry a unit ("11¢", "$3"); spread the number, keep the unit.
    let pre = "", suf = "";
    const raw = items.map(x => String(x).trim());
    const um = raw[0].match(/^(\$?)-?\d+(¢?)$/);
    if (um && (um[1] || um[2]) && raw.every(x => x.startsWith(um[1]) && x.endsWith(um[2]))
        && String(scr.answer).trim().startsWith(um[1]) && String(scr.answer).trim().endsWith(um[2])) {
      pre = um[1]; suf = um[2];
    }
    const strip = x => { let t = String(x).trim(); if (pre) t = t.slice(pre.length); if (suf) t = t.slice(0, -suf.length); return t; };
    const strs = items.map(x => (typeof x === "string" || typeof x === "number") ? strip(x) : null);
    // Negative choices (e.g. "-9" for 22 − 21) are in the banks too; they get
    // replaced below since a child can rule them out without doing the math.
    if (!strs.every(x => x !== null && /^-?\d+$/.test(x))) return;
    const ans = Number(strip(scr.answer));
    const v = strs.map(Number).sort((a, b) => a - b);
    const fmt = n => pre + String(n) + suf;
    if (!v.includes(ans) || new Set(v).size !== v.length) return;
    const n = v.length;
    // Evenly spaced choices (11, 12, 13, 14 or 6¢, 11¢, 16¢, 21¢): slide the
    // whole run so the answer can sit anywhere in it.
    const step = v[1] - v[0];
    let run = step > 0;
    for (let i = 1; i < n; i++) if (v[i] - v[i - 1] !== step) run = false;
    if (run) {
      const floor = v[0] >= step ? step : (v[0] >= 1 ? 1 : 0);
      let lo = ans - step * Math.floor(Math.random() * n);
      while (lo < floor) lo += step;
      scr.items = v.map((_, i) => fmt(lo + step * i));
      return;
    }
    // Mistake-style set: keep each distractor's distance from the answer (the
    // mistake it stands for) but flip sides so the answer's rank is uniform.
    const dists = [];
    for (const x of v) {
      if (x === ans) continue;
      let d = Math.abs(x - ans);
      while (dists.includes(d)) d += 1;   // answer±1 pairs would pin the answer mid-pack
      dists.push(d);
    }
    for (let tries = 0; tries < 40; tries++) {
      const below = Math.floor(Math.random() * n);          // answer's rank
      const order = dists.map((d, i) => i).sort(() => Math.random() - 0.5);
      const neg = new Set(order.slice(0, below));
      const out = dists.map((d, i) => neg.has(i) ? ans - d : ans + d);
      if (out.some(x => x < 0) || new Set([...out, ans]).size !== n) continue;
      scr.items = [...out, ans].sort((a, b) => a - b).map(fmt);
      return;
    }
  }


  // ---- Silent WAV (browser fallback for /api/say) ----
  function silentWav(ms) {
    const rate = 8000, n = Math.max(1, Math.round(rate * ms / 1000));
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); wstr(8, "WAVE");
    wstr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wstr(36, "data"); v.setUint32(40, n * 2, true);
    return buf;
  }

  // ---- Native TTS bridge ----
  let _ttsSeq = 0;
  const _ttsWaiters = {};
  window.__bfTTS = {
    done(id) { const w = _ttsWaiters[id]; if (w) { delete _ttsWaiters[id]; w(); } },
  };
  const BF = window.BF = {
    nativeTTS: !!nativeTTS,
    native: !!nativeStore,
    kv: BFKV,
    speak(text, opts) {
      if (!nativeTTS) return Promise.resolve();
      const id = ++_ttsSeq;
      return new Promise(res => {
        _ttsWaiters[id] = res;
        try { nativeTTS.postMessage({ cmd: "speak", id, text: String(text), interrupt: !!(opts && opts.interrupt) }); }
        catch (_) { delete _ttsWaiters[id]; res(); }
        // Safety: never leave a caller hanging > 30s
        setTimeout(() => window.__bfTTS.done(id), 30000);
      });
    },
    stopSpeak() {
      if (!nativeTTS) return;
      try { nativeTTS.postMessage({ cmd: "stop" }); } catch (_) {}
      // resolve anything pending — audio was cut
      for (const id of Object.keys(_ttsWaiters)) window.__bfTTS.done(id);
    },
    resetKid(kidId) {   // parent/dev helper
      const kid = KIDS_all()[kidId];
      if (kid && STORE.kids[kidId]) { STORE.kids[kidId] = blankKidDB(kid); persist(true); }
    },
  };

  // ---- Route handlers ----
  const J = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200, headers: { "content-type": "application/json" },
  });

  const routes = {
    "GET /api/health": async () => J({
      ok: true, model: "on-device", llm_healthy: true, kids: Object.keys(KIDS_all()), engine: "brainforest",
    }),

    "GET /api/kids": async () => J({
      kids: Object.values(KIDS_all()).map(k => ({
        id: k.id, name: k.display, grade: k.grade, grade_label: k.grade_label,
        emoji: k.emoji, color: k.color, tutor_name: k.tutor_name,
      })),
    }),

    // New in Brainforest: add a kid profile (any grade K-4) from the picker.
    "POST /api/kid/create": async (body) => {
      body = body || {};
      const name = String(body.name || "").trim().slice(0, 20);
      const grade = Math.max(0, Math.min(4, Number(body.grade) || 0));
      if (!name) return J({ error: "name required" }, 400);
      let id = name.toLowerCase().replace(/[^a-z0-9]/g, "") || "kid";
      const all = KIDS_all();
      let n = 2, base = id;
      while (all[id]) { id = base + n; n += 1; }
      const palette = ["#ff3aa1", "#6b4eff", "#00b894", "#ff8a4d", "#4ea8ff", "#e84393"];
      const emojis = ["🌟", "🦋", "🌈", "🚀", "🐯", "🍀", "🌻"];
      const p = {
        id, display: name, grade,
        age: 5 + grade,
        emoji: body.emoji || choice(emojis),
        color: body.color || choice(palette),
        default_theme: body.theme || "unicorns",
      };
      profiles().push(p);
      const kid = kidFromProfile(p);
      STORE.kids[id] = blankKidDB(kid);
      persist(true);
      return J({ ok: true, kid: { id, name: kid.display, grade: kid.grade, grade_label: kid.grade_label,
                                  emoji: kid.emoji, color: kid.color, tutor_name: kid.tutor_name } });
    },

    "GET /api/state": async () => {
      const kid = currentKid();
      let themes;
      try { themes = JSON.parse(getPref(kid, "themes", JSON.stringify(kid.themes))); }
      catch (_) { themes = kid.themes; }
      return J({
        kid: kid.id, kid_name: kid.display, grade: kid.grade,
        name: getPref(kid, "name", kid.display),
        tutor_name: getPref(kid, "tutor_name", kid.tutor_name),
        themes,
        favorite_theme: getPref(kid, "favorite_theme") || kid.default_theme,
        mastery: masterySummary(kid),
        model: "on-device",
        activity_seconds: kid.activity_seconds,
        quest_steps: kid.quest_steps,
      });
    },

    "POST /api/pref": async (body) => {
      const kid = currentKid();
      for (const k of Object.keys(body || {})) {
        const v = body[k];
        setPref(kid, k, typeof v === "string" ? v : JSON.stringify(v));
      }
      return J({ ok: true });
    },

    "POST /api/session/start": async (body) => {
      const kid = currentKid();
      const db = kidDB(kid);
      const sid = (Number(getPref(kid, "session_seq", "0")) || 0) + 1;
      setPref(kid, "session_seq", String(sid));
      db.sessions.push({ id: sid, started_at: nowISO(), theme: (body || {}).theme || null,
                         ended_at: null, seconds_active: 0, activities_done: 0 });
      cap(db.sessions, 200);

      const today = localDateISO();
      const last = getPref(kid, "last_play_date");
      let streak = Number(getPref(kid, "streak_days", "0")) || 0;
      const newDay = last !== today;
      let bonus = null;
      if (newDay) {
        const yesterday = localDateISO(new Date(Date.now() - 86400e3));
        streak = last === yesterday ? streak + 1 : 1;
        setPref(kid, "last_play_date", today);
        setPref(kid, "streak_days", String(streak));
        if (streak >= 3 && streak % 3 === 0) bonus = awardTreasure(kid, (body || {}).theme);
      }
      return J({ session_id: sid, streak_days: streak, streak_new_day: newDay, streak_bonus: bonus });
    },

    "POST /api/session/end": async (body) => {
      const kid = currentKid();
      const s = kidDB(kid).sessions.find(x => x.id === (body || {}).session_id);
      if (s) {
        s.ended_at = nowISO();
        s.seconds_active = (body || {}).seconds || 0;
        s.activities_done = (body || {}).activities || 0;
        persist(true);
      }
      return J({ ok: true });
    },

    "POST /api/attempt": async (body) => {
      const kid = currentKid();
      recordAttempt(kid, body || {});
      const sticker = (body || {}).correct ? awardSticker(kid, (body || {}).theme) : null;
      return J({ ok: true, sticker });
    },

    "POST /api/quest/complete": async (body) => {
      const kid = currentKid();
      const treasure = awardTreasure(kid, (body || {}).theme);
      const quests = (Number(getPref(kid, "quests_done", "0")) || 0) + 1;
      setPref(kid, "quests_done", String(quests));
      return J({ treasure, quests_done: quests });
    },

    "GET /api/collection": async () => {
      const kid = currentKid();
      const out = collectionSummary(kid);
      out.quests_done = Number(getPref(kid, "quests_done", "0")) || 0;
      return J(out);
    },

    "POST /api/next": async (body) => {
      await ready;
      const kid = currentKid();
      body = (body && typeof body === "object") ? body : {};
      const history = Array.isArray(body.history) ? body.history : [];
      const themePin = body.theme || getPref(kid, "favorite_theme") || kid.default_theme;
      const tiers = skillTiers(kid);

      const db = kidDB(kid);
      const bankSkills = [...new Set(bankForGrade(kid.grade).map(a => a.skill))];
      const validSkills = new Set((PATH_CURRICULUM[kid.grade] || []).map(n => n.key));
      const focusSkill = body.skill;

      // Pick the skill FIRST, then use that skill's own level. Using the lowest
      // level across every skill kept the whole app at the starting difficulty.
      let skill;
      if (focusSkill && validSkills.has(focusSkill)) skill = focusSkill;
      else {
        const weak = masterySummary(kid)
          .filter(m => m.score < 0.6 && bankSkills.includes(m.skill)).map(m => m.skill);
        if (weak.length && Math.random() < 0.3) skill = choice(weak);
        else {
          // Even rotation across the grade's skills, never the same one twice
          // running. A skill with only a handful of questions gets a smaller
          // share so one spelling word isn't asked thirty times a week.
          const others = bankSkills.filter(sk => sk !== db.lastSkill);
          const pick = others.length ? others : bankSkills;
          const size = {};
          for (const a of bankForGrade(kid.grade)) size[a.skill] = (size[a.skill] || 0) + 1;
          const w = pick.map(sk => Math.min(size[sk] || 1, 12));
          let r = Math.random() * w.reduce((x, y) => x + y, 0);
          skill = pick[pick.length - 1];
          for (let i = 0; i < pick.length; i++) { r -= w[i]; if (r < 0) { skill = pick[i]; break; } }
        }
      }

      // Recent questions live in the kid's own record (not the app's 8-item
      // history), so the one on screen and the ones from last session are skipped too.
      const recentKey = "g" + kid.grade;
      if (!db.recentServed || db.recentServed.grade !== recentKey) db.recentServed = { grade: recentKey, ids: [] };

      // Three misses in a row: ease off right away. Switch to a subject she's
      // doing well in (when there is one) at its easiest level, so the next
      // question is a win, instead of waiting for the running score to sink.
      const frustrated = !!body.frustration;
      const mBySkill = {};
      for (const m of masterySummary(kid)) mBySkill[m.skill] = m;
      if (frustrated && !(focusSkill && validSkills.has(focusSkill))) {
        const strong = bankSkills.filter(sk => mBySkill[sk] && mBySkill[sk].score >= 0.75);
        if (strong.length) skill = choice(strong);
      }
      const useTiers = frustrated ? Object.assign({}, tiers, { [skill]: 0 }) : tiers;
      const easiest = (g) => (TIER_CAPS[g] || TIER_CAPS[1])[0].band;
      const hasSkill = (g) => !!(CONTENT.bank[g] && CONTENT.bank[g].some(a => a.skill === skill));

      // Stretch and support: at the top level of a subject, now and then pull
      // the same subject from the next grade up; stuck at the bottom, now and
      // then from the grade below. Content stops being a ceiling or a wall.
      const m = mBySkill[skill];
      const tier = useTiers[skill] || 0;
      let serveGrade = kid.grade, band = tierCaps(kid, skill, useTiers).band, capped = true;
      if (frustrated) {
        // Easiest questions this subject actually has (bank difficulty labels
        // differ by subject, so the grade's first band can still be hard).
        const ds = bankForGrade(kid.grade).filter(a => a.skill === skill).map(a => a.difficulty);
        const lo = ds.length ? Math.min(...ds) : easiest(kid.grade)[0];
        band = [lo, lo];
      }
      else if (tier === 3 && Math.random() < 0.3 && hasSkill(kid.grade + 1)) {
        serveGrade = kid.grade + 1; band = easiest(serveGrade); capped = false;
      } else if (tier === 0 && m && m.attempts >= 6 && m.score < 0.45 && Math.random() < 0.3 && hasSkill(kid.grade - 1)) {
        serveGrade = kid.grade - 1; band = easiest(serveGrade); capped = false;
      }
      const out = bankServe(kid, {
        skill, theme: themePin, band, grade: serveGrade,
        predicate: capped ? (t) => withinCaps(kid, useTiers, t) : null,
        recentIds: db.recentServed.ids,
      });
      if (serveGrade !== kid.grade) out.stretch = serveGrade > kid.grade ? "up" : "down";
      db.recentServed.ids.push(out.bank_id);
      cap(db.recentServed.ids, 60);
      db.lastSkill = skill;
      persist();
      return J(out);
    },

    "POST /api/fact": async (body) => {
      await ready;
      const kid = currentKid();
      body = (body && typeof body === "object") ? body : {};
      const db = kidDB(kid);
      const recent = Array.isArray(body.recent) ? body.recent : [];
      const exclude = new Set([...recent, ...db.factsShown.slice(-80)]);
      const grade = kid.fact_grade;
      let candidates = CONTENT.facts.filter(f =>
        f.grade === grade && (!body.category || f.category === body.category) && !exclude.has(f.text));
      if (!candidates.length) {
        candidates = CONTENT.facts.filter(f =>
          f.grade === grade && (!body.category || f.category === body.category));
      }
      if (!candidates.length) return J({ text: "", category: "" });
      const fact = { ...choice(candidates) };
      db.factsShown.push(fact.text);
      cap(db.factsShown, 200);
      persist();
      return J(fact);
    },

    "POST /api/grade": async (body) => {
      body = body || {};
      const expected = String(body.expected || "").trim().toLowerCase();
      const got = String(body.got || "").trim().toLowerCase();
      // Whole-word match only: "2" must not pass for 12, "a" must not pass for "cat".
      const padded = " " + got.split(/[^a-z0-9']+/).filter(Boolean).join(" ") + " ";
      if (got && expected && (got === expected || padded.includes(" " + expected + " "))) {
        return J({ correct: true, feedback: "exact" });
      }
      const nums = { zero:"0", one:"1", two:"2", three:"3", four:"4", five:"5",
        six:"6", seven:"7", eight:"8", nine:"9", ten:"10", eleven:"11", twelve:"12",
        thirteen:"13", fourteen:"14", fifteen:"15", sixteen:"16", seventeen:"17",
        eighteen:"18", nineteen:"19", twenty:"20" };
      const digits = (got.match(/\d/g) || []).join("");
      const lastWord = got.split(/\s+/).pop() || "";
      const normGot = digits || nums[lastWord] || "";
      if (normGot && normGot === expected) return J({ correct: true, feedback: "number-normalized" });
      return J({ correct: false, feedback: "Good try — let's look again!" });
    },

    "GET /api/mastery": async () => J({ mastery: masterySummary(currentKid()) }),

    // Parent dashboard: recent sessions, newest first.
    "GET /api/sessions": async () => {
      const kid = currentKid();
      const sessions = kidDB(kid).sessions.slice(-20).reverse().map(s => ({
        started_at: s.started_at, ended_at: s.ended_at, theme: s.theme,
        activities_done: s.activities_done || 0,
        minutes: Math.round((s.seconds_active || 0) / 60),
      }));
      return J({ sessions });
    },

    "GET /api/path": async () => {
      const kid = currentKid();
      const bySkill = {};
      for (const m of masterySummary(kid)) bySkill[m.skill] = m;
      const nodes = (PATH_CURRICULUM[kid.grade] || []).map(item => {
        const m = bySkill[item.key];
        const score = m ? m.score : 0;
        const attempts = m ? m.attempts : 0;
        const correct = m ? m.correct : 0;
        const status = attempts === 0 ? "new" : (score >= MASTERED_AT && attempts >= 8 ? "mastered" : "learning");
        return { ...item, score: Math.round(score * 1000) / 1000, attempts, correct, status };
      });
      return J({
        grade: kid.grade,
        nodes,
        mastered: nodes.filter(n => n.status === "mastered").length,
        started: nodes.filter(n => n.status !== "new").length,
        total: nodes.length,
      });
    },

    "POST /api/say": async (body) => {
      const text = String((body || {}).text || "").trim();
      if (text && nativeTTS) BF.speak(text);   // fire and forget — caller plays silent wav
      return new Response(silentWav(60), {
        status: 200, headers: { "content-type": "audio/wav", "x-voice": nativeTTS ? "ios-native" : "silent" },
      });
    },

    "POST /api/say/stop": async () => { BF.stopSpeak(); return J({ ok: true }); },
  };

  // ---- fetch interception ----
  window.fetch = function (url, opts) {
    const u = String(url);
    const path = u.startsWith("http") ? new URL(u).pathname : u.split("?")[0];
    if (path.startsWith("/api/")) {
      const method = ((opts && opts.method) || "GET").toUpperCase();
      const handler = routes[method + " " + path];
      if (!handler) return Promise.resolve(J({ error: "no such route: " + method + " " + path }, 404));
      // Routes that need an active kid fail cleanly when no profiles exist yet.
      const kidFree = new Set(["/api/kids", "/api/kid/create", "/api/health", "/api/grade", "/api/say", "/api/say/stop"]);
      if (!kidFree.has(path) && !currentKid()) {
        return Promise.resolve(J({ error: "no kids yet" }, 409));
      }
      let bodyP = Promise.resolve(null);
      if (opts && opts.body) {
        try { bodyP = Promise.resolve(JSON.parse(opts.body)); } catch (_) {}
      }
      return bodyP.then(b => handler(b)).catch(e => {
        console.error("[engine]", method, path, e);
        return J({ error: String(e) }, 500);
      });
    }
    return realFetch(url, opts);
  };

  // Flush pending saves when the app backgrounds
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persist(true);
  });

  console.log("[engine] Brainforest engine ready — native store:", !!nativeStore, "native tts:", !!nativeTTS);
})();
