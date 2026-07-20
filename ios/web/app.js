/* Learning World — kid-friendly tutor app (multi-kid: Jane g1, Liv g3) */

const $ = (id) => document.getElementById(id);
const cls = (el, c, on) => el.classList[on ? "add" : "remove"](c);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Cookie helpers ----
// In Brainforest these ride the engine's persistent KV (native-backed) —
// document.cookie doesn't survive relaunches under the bf:// scheme.
function getCookie(name) {
  if (window.BF) return BF.kv.get(name);
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(name, value, days = 365) {
  if (window.BF) { BF.kv.set(name, String(value)); return; }
  const exp = new Date(Date.now() + days * 86400e3).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${exp}; samesite=lax`;
}
function kvGet(name) { return window.BF ? BF.kv.get(name) : localStorage.getItem(name); }
function kvSet(name, v) { window.BF ? BF.kv.set(name, v) : localStorage.setItem(name, v); }

// ---- State ----
window.STATE = window.STATE || {};
const STATE = window.STATE;
// Per-kid launchers pass ?kid=jane|liv — promote that into the cookie so the
// rest of the app, and every API call, locks to this kid.
const _kidFromUrl = new URLSearchParams(window.location.search).get("kid");
if (_kidFromUrl) setCookie("kid", _kidFromUrl);

Object.assign(STATE, {
  kid: _kidFromUrl || getCookie("kid") || null,   // null → show picker first
  kidName: "",
  name: "",
  tutorName: "Bloom",
  themes: ["unicorns","dinos","mermaids","bluey","space","cats","horses"],
  sessionId: null,
  theme: null,
  activitiesDone: 0,
  startedAt: 0,
  history: [],
  current: null,
  rightStreak: 0,
  wrongStreak: 0,
  driftTimer: null,
  lastSpoken: "",
  recognition: null,
  voice: null,
  voiceOn: kvGet("janeos_voice_off") !== "1",
  factSeen: [],              // last 80 fact texts (avoid repeats)
  factTickerTimer: null,     // rotates the on-screen fact during activity
  questSteps: 8,             // activities per session quest (per kid, from /api/state)
  questStep: 0,              // how far up the treehouse this session
  retried: false,            // kid already used her retry on this activity
  renderedAt: 0,             // when the current activity hit the screen (for latency)
});

// ---- Boot ----
(async function boot() {
  // Show the right screen IMMEDIATELY based on cookie — never block on network.
  // On slow cell connections /api/kids could take 10+s (cloudflare cold start),
  // and every .screen is display:none by default, so awaiting here would leave
  // the page blank until the fetch returned.
  // Deep-link: /path  (or ?view=path / #path) opens straight to the Learning Path map.
  const _wantPath = new URLSearchParams(location.search).get("view") === "path"
    || location.pathname.replace(/\/+$/, "") === "/path"
    || location.hash === "#path";

  if (!STATE.kid) {
    cls($("kid-picker"), "active", true);
  } else if (_wantPath) {
    openPath();
  } else {
    cls($("welcome"), "active", true);
  }

  // Init voices early — Chrome populates async
  if ("speechSynthesis" in window) {
    speechSynthesis.onvoiceschanged = pickVoice;
    pickVoice();
  }

  // Populate kid cards in the background — picker is already visible
  buildKidPicker().catch(e => console.warn("kids load failed", e));

  // If we have a kid cookie, load state in the background (welcome already up)
  if (STATE.kid) {
    loadKidState().catch(e => console.warn("kid state load failed", e));
  }

  // Theme buttons — prime audio on first click (browser autoplay policy)
  document.querySelectorAll(".theme-card").forEach(btn => {
    btn.addEventListener("click", () => { primeAudio(); onPickTheme(btn.dataset.theme); });
  });

  $("repeat-btn").addEventListener("click", repeatCurrent);
  $("next-btn").addEventListener("click", advance);
  $("break-btn").addEventListener("click", goHome);
  $("parent-btn").addEventListener("click", () => { window.location.href = "parent.html"; });
  const sk = $("switch-kid-btn");
  if (sk) sk.addEventListener("click", switchKid);

  const pb = $("path-btn");
  if (pb) pb.addEventListener("click", () => { primeAudio(); openPath(); });
  const bb = $("book-btn");
  if (bb) bb.addEventListener("click", () => { primeAudio(); openStickerBook(); });
  const bbk = $("book-back-btn");
  if (bbk) bbk.addEventListener("click", () => {
    cls($("stickerbook"), "active", false);
    cls($("welcome"), "active", true);
  });
  const pbk = $("path-back-btn");
  if (pbk) pbk.addEventListener("click", () => {
    cls($("path"), "active", false);
    cls($("welcome"), "active", true);
  });

  // Voice toggle — big playful side button
  const vt = $("voice-toggle");
  if (vt) {
    applyVoiceToggleVisual();
    vt.addEventListener("click", () => {
      STATE.voiceOn = !STATE.voiceOn;
      kvSet("janeos_voice_off", STATE.voiceOn ? "0" : "1");
      if (!STATE.voiceOn) {
        // Stop anything currently playing + clear queue
        _tts_queue = [];
        if (_tts_audio) { try { _tts_audio.pause(); } catch(_){} }
        _tts_playing = false;
        if (window.BF && BF.nativeTTS) BF.stopSpeak();
      }
      applyVoiceToggleVisual();
    });
  }
})();

// ---- Kid picker ----
async function buildKidPicker() {
  const grid = $("kid-grid");
  if (!grid) return;
  let kids = [];
  try {
    const r = await fetch("/api/kids");
    const j = await r.json();
    kids = j.kids || [];
  } catch (e) { console.warn("kids load failed", e); }
  grid.innerHTML = "";
  kids.forEach(k => {
    const btn = document.createElement("button");
    btn.className = "kid-card";
    btn.dataset.kid = k.id;
    btn.style.setProperty("--kid-color", k.color || "#ff3aa1");
    const gradeText = k.grade === 0 ? "Kindergarten"
      : (k.grade_label ? `${k.grade_label} grade` : `Grade ${k.grade}`);
    btn.innerHTML = `
      <span class="kid-emoji">${k.emoji || "🌟"}</span>
      <span class="kid-name">${k.name}</span>
      <span class="kid-grade">${gradeText}</span>
    `;
    btn.addEventListener("click", () => { if (window.SFX) SFX.play("tap"); onPickKid(k.id); });
    grid.appendChild(btn);
  });
  // "Add a kid" card — any grade K-4
  const add = document.createElement("button");
  add.className = "kid-card add-kid-card";
  add.innerHTML = `<span class="kid-emoji">➕</span><span class="kid-name">Add a kid</span><span class="kid-grade">K to 4th</span>`;
  add.addEventListener("click", openAddKid);
  grid.appendChild(add);
}

// ---- Add-a-kid modal ----
let _addKidGrade = null;
function openAddKid() {
  _addKidGrade = null;
  const modal = $("addkid");
  if (!modal) return;
  $("addkid-name").value = "";
  modal.querySelectorAll(".grade-btn").forEach(b => b.classList.remove("selected"));
  cls(modal, "hidden", false);
  if (!modal.__wired) {
    modal.__wired = true;
    modal.querySelectorAll(".grade-btn").forEach(b => {
      b.addEventListener("click", () => {
        modal.querySelectorAll(".grade-btn").forEach(x => x.classList.remove("selected"));
        b.classList.add("selected");
        _addKidGrade = Number(b.dataset.grade);
        if (window.SFX) SFX.play("tap");
      });
    });
    $("addkid-cancel").addEventListener("click", () => cls(modal, "hidden", true));
    $("addkid-save").addEventListener("click", async () => {
      const name = $("addkid-name").value.trim();
      if (!name || _addKidGrade === null) return;
      try {
        const r = await fetch("/api/kid/create", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, grade: _addKidGrade }),
        });
        const j = await r.json();
        if (j.ok && j.kid) {
          cls(modal, "hidden", true);
          await buildKidPicker();
          onPickKid(j.kid.id);
        }
      } catch (e) { console.warn("add kid failed", e); }
    });
  }
}

async function onPickKid(kidId) {
  setCookie("kid", kidId);
  STATE.kid = kidId;
  await loadKidState();
  cls($("kid-picker"), "active", false);
  cls($("welcome"), "active", true);
}

async function loadKidState() {
  try {
    const r = await fetch("/api/state");
    const s = await r.json();
    if (s.error || !s.kid) {
      // Stale kid selection (e.g. profile removed) — back to the picker.
      STATE.kid = null;
      setCookie("kid", "");
      cls($("welcome"), "active", false);
      cls($("kid-picker"), "active", true);
      return;
    }
    STATE.kid = s.kid;
    STATE.grade = s.grade || 1;
    STATE.kidName = s.kid_name || "";
    STATE.name = s.name || s.kid_name || "";
    STATE.tutorName = s.tutor_name || "Bloom";
    STATE.themes = s.themes || STATE.themes;
    STATE.favoriteTheme = s.favorite_theme || STATE.themes[0] || "unicorns";
    STATE.questSteps = s.quest_steps || 8;
    const wn = $("welcome-name");
    if (STATE.name) {
      wn.textContent = " " + STATE.name;
    } else {
      wn.textContent = "";
      const heading = wn.parentElement;
      if (heading) heading.textContent = heading.textContent.replace(/\s+!/, "!");
    }
    // Body class so CSS can theme per kid (e.g., Liv vs Jane palette)
    document.body.classList.remove("kid-jane", "kid-liv");
    if (STATE.kid) document.body.classList.add("kid-" + STATE.kid);
  } catch (e) {
    console.warn("state load failed", e);
  }
}

async function switchKid() {
  // End any active session cleanly first
  if (STATE.sessionId) {
    const seconds = Math.round((Date.now() - STATE.startedAt) / 1000);
    fetch("/api/session/end", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify({session_id: STATE.sessionId, seconds, activities: STATE.activitiesDone}),
    }).catch(()=>{});
    STATE.sessionId = null;
  }
  cls($("welcome"), "active", false);
  cls($("lesson"), "active", false);
  cls($("kid-picker"), "active", true);
}

// ---- Learning Path / world map ----
async function openPath() {
  cls($("welcome"), "active", false);
  cls($("path"), "active", true);
  const map = $("path-map");
  map.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
  let data;
  try {
    const r = await fetch("/api/path");
    data = await r.json();
  } catch (e) {
    console.warn("path load failed", e);
    map.innerHTML = '<p class="path-empty">Couldn\'t load your path — try again!</p>';
    return;
  }
  renderPath(data);
}

function renderPath(data) {
  const map = $("path-map");
  map.innerHTML = "";
  const nodes = data.nodes || [];

  // Overall progress header
  const fill = $("path-progress-fill");
  const label = $("path-progress-label");
  const total = data.total || nodes.length || 1;
  const mastered = data.mastered || 0;
  if (fill) fill.style.width = Math.round((mastered / total) * 100) + "%";
  if (label) label.textContent = mastered > 0
    ? `${mastered} of ${total} islands mastered — keep climbing! 🌟`
    : `${total} islands to explore — tap one to start! 🚀`;

  // Group nodes into "lands"
  const groups = [];
  const seen = {};
  nodes.forEach(n => {
    if (!seen[n.group]) { seen[n.group] = { name: n.group, items: [] }; groups.push(seen[n.group]); }
    seen[n.group].items.push(n);
  });

  groups.forEach(g => {
    const land = document.createElement("div");
    land.className = "path-land";
    const h = document.createElement("h2");
    h.className = "path-land-title";
    h.textContent = g.name;
    land.appendChild(h);

    const trail = document.createElement("div");
    trail.className = "path-trail";
    g.items.forEach(n => trail.appendChild(buildIsland(n)));
    land.appendChild(trail);
    map.appendChild(land);
  });
}

function buildIsland(n) {
  const pct = Math.round((n.score || 0) * 100);
  const btn = document.createElement("button");
  btn.className = "path-island is-" + n.status;
  btn.setAttribute("aria-label", `${n.label}, ${n.status}`);

  // Progress ring (conic-gradient driven by mastery score)
  const ring = document.createElement("span");
  ring.className = "island-ring";
  ring.style.setProperty("--pct", pct);
  const face = document.createElement("span");
  face.className = "island-face";
  face.textContent = n.emoji;
  ring.appendChild(face);

  // Gold star badge once mastered
  if (n.status === "mastered") {
    const star = document.createElement("span");
    star.className = "island-star";
    star.textContent = "⭐";
    ring.appendChild(star);
  }
  btn.appendChild(ring);

  const name = document.createElement("span");
  name.className = "island-name";
  name.textContent = n.label;
  btn.appendChild(name);

  const sub = document.createElement("span");
  sub.className = "island-sub";
  sub.textContent = n.status === "new" ? "new!"
    : n.status === "mastered" ? "mastered!"
    : pct + "%";
  btn.appendChild(sub);

  btn.addEventListener("click", () => {
    primeAudio();
    const theme = STATE.theme || STATE.favoriteTheme || "unicorns";
    cls($("path"), "active", false);
    onPickTheme(theme, n.key, n.label);
  });
  return btn;
}

// ---- Did-you-know facts ----
async function fetchFact(opts = {}) {
  try {
    const r = await fetch("/api/fact", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        category: opts.category || null,
        recent: STATE.factSeen.slice(-40),
      }),
    });
    const f = await r.json();
    if (f && f.text) {
      STATE.factSeen.push(f.text);
      if (STATE.factSeen.length > 80) STATE.factSeen.shift();
    }
    return f;
  } catch (e) {
    console.warn("fact fetch failed", e);
    return null;
  }
}

// Show a visual fact card. NO audio — kid reads it. Stays until tapped or
// auto-dismisses after FACT_HOLD_MS. Returns a promise that resolves when
// the card is dismissed, so the calling flow can wait before advancing.
const FACT_HOLD_MS = 6500;   // dwell time so kid has time to read

function showFactToast(fact) {
  const el = $("fact-toast");
  const txt = $("fact-text");
  if (!el || !txt || !fact) return Promise.resolve();
  // If a previous toast is still awaiting dismissal, resolve it now —
  // otherwise grade() (which awaits showFactToast) would hang forever
  // when the periodic fact ticker fires mid-grade and swaps in a new toast.
  if (STATE._factToastDismiss) {
    try { STATE._factToastDismiss(); } catch (_) {}
  }
  clearTimeout(STATE._factToastTimer);
  txt.textContent = fact.text || fact.short || "";
  cls(el, "hidden", false);
  cls(el, "show", true);
  return new Promise((resolve) => {
    let done = false;
    const dismiss = () => {
      if (done) return;
      done = true;
      cls(el, "show", false);
      cls(el, "hidden", true);
      el.removeEventListener("click", dismiss);
      if (STATE._factToastDismiss === dismiss) STATE._factToastDismiss = null;
      resolve();
    };
    STATE._factToastDismiss = dismiss;
    // Tap anywhere on the card dismisses it early
    el.addEventListener("click", dismiss);
    STATE._factToastTimer = setTimeout(dismiss, FACT_HOLD_MS);
  });
}

// Fact toasts at the top were distracting during questions for every grade —
// removed entirely (Matt, 2026-07-07). Facts are spoken-only now (see finalize).
function startFactTicker() {
  stopFactTicker();
}
function stopFactTicker() {
  if (STATE.factTickerTimer) {
    clearInterval(STATE.factTickerTimer);
    STATE.factTickerTimer = null;
  }
}

function applyVoiceToggleVisual() {
  const vt = $("voice-toggle");
  if (!vt) return;
  const on = STATE.voiceOn;
  vt.classList.toggle("voice-on", on);
  vt.classList.toggle("voice-off", !on);
  vt.setAttribute("aria-pressed", on ? "true" : "false");
  const emoji = vt.querySelector(".vt-emoji");
  const label = vt.querySelector(".vt-label");
  if (emoji) emoji.textContent = on ? "🔊" : "🔇";
  if (label) label.textContent = on ? "voice" : "muted";
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  // Prefer the most natural-sounding voices first.
  // macOS "Premium"/"Enhanced" voices are neural and far better than the default.
  const order = [
    "Ava (Premium)", "Zoe (Premium)", "Allison (Premium)", "Samantha (Premium)",
    "Allison (Enhanced)", "Samantha (Enhanced)", "Ava (Enhanced)",
    "Google US English", "Microsoft Aria",
    "Ava", "Allison", "Samantha", "Karen", "Moira",
  ];
  for (const want of order) {
    const v = voices.find(x => x.name === want || x.name.startsWith(want));
    if (v) { STATE.voice = v; console.log("[tts] using voice:", v.name); return; }
  }
  STATE.voice = voices.find(v => v.lang && v.lang.startsWith("en")) || voices[0];
  if (STATE.voice) console.log("[tts] fallback voice:", STATE.voice.name);
}

// ---- Speak (server synthesizes Piper WAV, browser plays it) ----
// Works for ANY device — remote users hear audio in their own browser.
let _tts_audio = null;
let _tts_queue = [];
let _tts_playing = false;

function _playNextInQueue() {
  if (_tts_playing) return;
  const item = _tts_queue.shift();
  if (!item) return;
  _tts_playing = true;
  // Resolve the awaiter ONCE — when audio finishes playing (or fails),
  // not when fetch returns. That way `await speak(text)` truly blocks
  // until the line is fully spoken, so callers can sequence cleanly.
  let resolved = false;
  const done = () => { if (!resolved && item.resolve) { resolved = true; item.resolve(); } };
  fetch("/api/say", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({text: item.text}),
  }).then(r => r.arrayBuffer()).then(buf => {
    const blob = new Blob([buf], {type: "audio/wav"});
    const url = URL.createObjectURL(blob);
    if (_tts_audio) { try { _tts_audio.pause(); } catch(_){} }
    _tts_audio = new Audio(url);
    const vt = document.getElementById("voice-toggle");
    if (vt && STATE.voiceOn) vt.classList.add("speaking");
    const _stopVisual = () => { if (vt) vt.classList.remove("speaking"); };
    _tts_audio.onended = () => {
      URL.revokeObjectURL(url);
      _tts_playing = false;
      _stopVisual();
      done();
      _playNextInQueue();
    };
    _tts_audio.onerror = () => {
      URL.revokeObjectURL(url);
      _tts_playing = false;
      _stopVisual();
      done();
      _playNextInQueue();
    };
    _tts_audio.play().catch(e => {
      console.warn("[tts] play failed (autoplay policy?)", e);
      _tts_playing = false;
      _stopVisual();
      done();
      _playNextInQueue();
    });
  }).catch(e => {
    console.warn("[tts] fetch failed", e);
    _tts_playing = false;
    done();
    _playNextInQueue();
  });
}

function speak(text, opts = {}) {
  if (!text) return Promise.resolve();
  STATE.lastSpoken = text;
  if (!STATE.voiceOn) return Promise.resolve();   // muted — skip TTS entirely
  // Native narration (Brainforest iOS): recorded voice pack / AVSpeech queue.
  // The returned promise resolves when the line has actually been spoken.
  if (window.BF && BF.nativeTTS) return BF.speak(String(text));
  return new Promise((resolve) => {
    _tts_queue.push({text: String(text), resolve});
    _playNextInQueue();
  });
}

function speakNow(text, opts = {}) {
  // Interrupt: stop current + clear queue
  _tts_queue = [];
  if (_tts_audio) { try { _tts_audio.pause(); } catch(_){} }
  _tts_playing = false;
  if (window.BF && BF.nativeTTS) BF.stopSpeak();
  if (!STATE.voiceOn) return Promise.resolve();   // muted — skip TTS entirely
  return speak(text, opts);
}

function primeAudio() {
  // Browser autoplay needs user gesture: kick off a silent fetch+play to "warm" the audio context
  if (window.SFX) SFX.prime();
  if (STATE.audioPrimed) return;
  STATE.audioPrimed = true;
  // Just calling .play() inside a click handler is enough to grant audio permission
  try {
    const a = new Audio();
    a.volume = 0;
    a.play().catch(() => {});
  } catch(_) {}
}

// ---- Listen (STT) ----
function startListen() {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return reject(new Error("Speech recognition not supported"));
    if (STATE.recognition) {
      try { STATE.recognition.abort(); } catch (_) {}
    }
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = false;
    r.maxAlternatives = 3;
    let got = false;
    r.onresult = (e) => {
      got = true;
      const alts = [];
      for (let i = 0; i < e.results[0].length; i++) alts.push(e.results[0][i].transcript);
      resolve(alts.join(" | "));
    };
    r.onerror = (e) => {
      if (!got) reject(new Error(e.error || "stt-error"));
    };
    r.onend = () => { if (!got) reject(new Error("no-speech")); };
    r.start();
    STATE.recognition = r;
  });
}

let listening = false;
async function toggleMic() {
  if (listening) {
    if (STATE.recognition) try { STATE.recognition.stop(); } catch(_){}
    return;
  }
  listening = true;
  cls($("mic-btn"), "listening", true);
  $("mic-btn").querySelector("span").textContent = "listening...";
  try {
    const heard = await startListen();
    onHeard(heard);
  } catch (e) {
    console.warn("stt err", e);
    flashFeedback("I didn't hear you, try again!", false);
  } finally {
    listening = false;
    cls($("mic-btn"), "listening", false);
    $("mic-btn").querySelector("span").textContent = "tap to talk";
  }
}

// ---- Theme pick → start session ----
async function onPickTheme(theme, focusSkill = null, focusLabel = "") {
  if (theme === "surprise") {
    theme = STATE.themes[Math.floor(Math.random() * STATE.themes.length)];
  }
  STATE.theme = theme;
  STATE.focusSkill = focusSkill;   // null = normal mixed play; set = path island
  STATE.focusLabel = focusLabel;
  document.body.className = "";
  document.body.classList.add(`theme-${theme}`);

  // Start backend session (also returns the daily streak)
  let streakLine = "", bonusTreasure = null, streakDays = 0;
  try {
    const r = await fetch("/api/session/start", {method:"POST",headers:{"content-type":"application/json"},body: JSON.stringify({theme})});
    const j = await r.json();
    STATE.sessionId = j.session_id;
    if (j.streak_new_day && j.streak_days >= 2) {
      streakLine = ` ${j.streak_days} days in a row!`;
      streakDays = j.streak_days;
      bonusTreasure = j.streak_bonus;
    }
  } catch (e) { console.warn(e); }

  STATE.startedAt = Date.now();
  STATE.activitiesDone = 0;
  STATE.history = [];
  STATE.rightStreak = 0;
  STATE.wrongStreak = 0;
  STATE.questStep = 0;
  STATE.comeback = [];            // missed questions waiting for a re-ask
  $("stickers").innerHTML = "";   // fresh tray each quest (the book keeps them forever)

  // Switch screens
  cls($("welcome"), "active", false);
  cls($("lesson"), "active", true);
  setBackdrop(theme);
  renderQuestTrail();
  startFactTicker();

  // Show greeting in the bubble immediately (don't wait for TTS)
  const who = STATE.name ? `Hi ${STATE.name}! ` : "Hi! ";
  const greet = (focusLabel
    ? `${who}Let's practice ${focusLabel} in the ${themePretty(theme)} world!`
    : `${who}A new treehouse quest! Answer ${STATE.questSteps} questions to climb to the top of the ${themePretty(theme)} treehouse!`)
    + streakLine;
  $("said").textContent = greet;
  $("content").innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';

  // Speak the greeting in PIECES so the recorded voice pack covers almost all
  // of it: the name part ("Hi Tess!") is the only dynamic bit — it plays as its
  // own tiny utterance (recorded for known kids, device voice for custom names)
  // while the long sentences are always full Amy recordings.
  speak(who.trim());
  speak(focusLabel
    ? `Let's practice ${focusLabel} in the ${themePretty(theme)} world!`
    : `A new treehouse quest! Answer ${STATE.questSteps} questions to climb to the top of the ${themePretty(theme)} treehouse!`);
  if (streakDays >= 2) speak(`${streakDays} days in a row!`);
  if (bonusTreasure) {
    addSticker(bonusTreasure.emoji);
    speak(`You earned the ${bonusTreasure.name} for playing so many days in a row! It's in your sticker book!`);
  }
  await nextActivity();
}

// Convert UPPERCASE words to TitleCase so TTS doesn't spell them letter-by-letter
function ttsFriendly(text) {
  if (!text) return text;
  return String(text).replace(/\b[A-Z]{2,}\b/g, w => w[0] + w.slice(1).toLowerCase());
}

// "Say again" — cancel anything in flight and replay the CURRENT activity prompt
// (not whatever happened to be the last queued utterance). This is what the kid
// actually wants when she taps the repeat button.
function repeatCurrent() {
  const text = STATE.current?.say || STATE.lastSpoken || "";
  if (!text) return;
  speakNow(ttsFriendly(text));  // interrupt + replay
}

function themePretty(t) {
  return ({unicorns:"unicorn",mermaids:"mermaid",dinos:"dinosaur",space:"space",cats:"kitty cat",horses:"horse",bluey:"puppy"})[t] || t;
}

// ---- Quest backdrop (themed treehouse art, generated locally) ----
// Only the active theme's image loads (one ~450KB jpg, week-long browser
// cache) so remote/VPS sessions stay light. If the image is missing the
// gradient background simply stays.
function setBackdrop(theme) {
  const el = $("backdrop");
  if (!el) return;
  el.classList.remove("show");
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url(${img.src})`;
    el.classList.add("show");
  };
  img.src = `img/quest/${theme}.jpg`;
}
function clearBackdrop() {
  const el = $("backdrop");
  if (el) { el.classList.remove("show"); el.style.backgroundImage = ""; }
}

// ---- Session quest: climb the treehouse, one rung per activity ----
function renderQuestTrail() {
  const trail = $("quest-trail");
  if (!trail) return;
  trail.innerHTML = "";
  for (let i = 0; i < STATE.questSteps; i++) {
    const stone = document.createElement("span");
    stone.className = "quest-stone" + (i < STATE.questStep ? " done" : "");
    trail.appendChild(stone);
  }
  const climber = document.createElement("span");
  climber.className = "quest-climber";
  climber.textContent = themeEmoji();
  const flag = document.createElement("span");
  flag.className = "quest-flag";
  flag.textContent = "🏠";
  // climber sits after the last done stone
  const stones = trail.querySelectorAll(".quest-stone");
  const at = Math.min(STATE.questStep, STATE.questSteps - 1);
  trail.insertBefore(climber, stones[at].nextSibling);
  trail.appendChild(flag);
}

function advanceQuest() {
  STATE.questStep++;
  renderQuestTrail();
  return STATE.questStep >= STATE.questSteps;
}

async function questFinale() {
  stopFactTicker();
  resetDrift();
  // Award a persistent treasure for the sticker book
  let treasure = null, quests = 0;
  try {
    const r = await fetch("/api/quest/complete", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({theme: STATE.theme}),
    });
    const j = await r.json();
    treasure = j.treasure;
    quests = j.quests_done || 0;
  } catch (e) { console.warn("quest complete failed", e); }

  const fin = $("finale");
  if (fin) {
    $("finale-treasure").textContent = treasure ? treasure.emoji : "🏆";
    $("finale-treasure-name").textContent = treasure ? treasure.name : "Champion Cup";
    $("finale-sub").textContent = quests > 1
      ? `That's ${quests} quests finished! It's in your sticker book.`
      : `Your first treasure! It's in your sticker book.`;
    cls(fin, "hidden", false);
    cls(fin, "show", true);
    fin.onclick = () => {
      cls(fin, "show", false);
      cls(fin, "hidden", true);
      goHome();
    };
  }
  if (window.SFX) SFX.play("finale");
  fireConfetti();
  const name = treasure ? treasure.name : "a treasure";
  speakNow(`You did it! You climbed all the way to the top of the treehouse! You earned the ${name}!`);
  // End the backend session now — the quest is the natural session arc.
  if (STATE.sessionId) {
    const seconds = Math.round((Date.now() - STATE.startedAt) / 1000);
    fetch("/api/session/end", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({session_id: STATE.sessionId, seconds, activities: STATE.activitiesDone}),
    }).catch(()=>{});
    STATE.sessionId = null;
  }
}

// ---- Sticker book (persistent collection) ----
async function openStickerBook() {
  cls($("welcome"), "active", false);
  cls($("stickerbook"), "active", true);
  const body = $("book-body");
  body.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
  let data;
  try {
    const r = await fetch("/api/collection");
    data = await r.json();
  } catch (e) {
    body.innerHTML = '<p class="path-empty">Couldn\'t open your book — try again!</p>';
    return;
  }
  body.innerHTML = "";

  const counts = document.createElement("p");
  counts.className = "book-counts";
  counts.textContent = `${data.total_stickers || 0} stickers · ${data.quests_done || 0} quests finished`;
  body.appendChild(counts);

  const th = document.createElement("h2");
  th.className = "book-section-title";
  th.textContent = "🏆 Treasures";
  body.appendChild(th);
  const tg = document.createElement("div");
  tg.className = "book-grid treasures";
  if ((data.treasures || []).length === 0) {
    const p = document.createElement("p");
    p.className = "book-empty";
    p.textContent = "Finish a quest to earn your first treasure!";
    tg.appendChild(p);
  }
  (data.treasures || []).forEach(t => {
    const card = document.createElement("div");
    card.className = "book-card treasure";
    card.innerHTML = `<span class="book-emoji">${t.emoji}</span>
      <span class="book-name">${t.name}</span>` +
      (t.count > 1 ? `<span class="book-count">×${t.count}</span>` : "");
    tg.appendChild(card);
  });
  body.appendChild(tg);

  const sh = document.createElement("h2");
  sh.className = "book-section-title";
  sh.textContent = "✨ Stickers";
  body.appendChild(sh);
  const sg = document.createElement("div");
  sg.className = "book-grid stickers-grid";
  if ((data.stickers || []).length === 0) {
    const p = document.createElement("p");
    p.className = "book-empty";
    p.textContent = "Right answers earn stickers — go play!";
    sg.appendChild(p);
  }
  (data.stickers || []).forEach(s => {
    const card = document.createElement("div");
    card.className = "book-card";
    card.innerHTML = `<span class="book-emoji">${s.item}</span>
      <span class="book-count">×${s.count}</span>`;
    sg.appendChild(card);
  });
  body.appendChild(sg);
}

// ---- Activity loop ----
async function fetchActivity() {
  try {
    const r = await fetch("/api/next", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify({
        history: STATE.history.slice(-8),
        theme: STATE.theme,
        skill: STATE.focusSkill || null,   // set when launched from a path island
        drift: false,
        frustration: STATE.wrongStreak >= 3,
      }),
    });
    return await r.json();
  } catch (e) {
    console.error(e);
    return {
      say: `Let's count! Tap the right number.`,
      screen: {type:"image_word", title:"🦄 🦄 🦄", prompt:"Count them!", items:["2","3","4","5"], answer:"3", theme: STATE.theme},
      expects:"tap", skill:"math_count", difficulty:1,
    };
  }
}

function prefetchNext() {
  // Fire-and-forget so the next activity is ready when she finishes the current one
  STATE.prefetched = fetchActivity();
}

async function nextActivity() {
  cls($("next-btn"), "hidden", true);
  resetDrift();
  // Clear any feedback flash from the PREVIOUS answer so it doesn't overlay
  // the new question (was leaking ~1.4s into the next render).
  document.querySelectorAll(".fb-flash").forEach(el => el.remove());

  // Stop any in-flight TTS + drop the queue so the kid isn't hearing the
  // PREVIOUS prompt while the NEW question is already on screen. Fast-tappers
  // were getting audio that lagged behind the visuals — this resets the audio
  // timeline to match the new activity.
  _tts_queue = [];
  if (_tts_audio) { try { _tts_audio.pause(); } catch(_){} }
  _tts_playing = false;
  // NOTE: native TTS is deliberately NOT stopped here — the praise line from
  // finalize() keeps playing over the incoming question (the new prompt queues
  // behind it). Stopping here cut off every congratulation on the phone.

  // Spaced repetition: a question she finally missed comes back a few
  // activities later — getting it right the second time is the learning.
  let payload;
  const dueIdx = (STATE.comeback || []).findIndex(c => STATE.activitiesDone >= c.due);
  if (dueIdx >= 0) {
    payload = STATE.comeback.splice(dueIdx, 1)[0].payload;
  }

  // Otherwise use prefetched if available — instant
  if (!payload && STATE.prefetched) {
    try { payload = await STATE.prefetched; } catch (_) {}
    STATE.prefetched = null;
  }
  if (!payload) {
    showLoading();
    payload = await fetchActivity();
  }
  STATE.current = payload;
  renderActivity(payload);
  prefetchNext();
  // Speak the NEW prompt immediately (queue was already cleared above).
  speak(ttsFriendly(payload.say || "Here we go!"));
  startDriftTimer();
}

function showLoading() {
  $("said").textContent = "...";
  const c = $("content");
  c.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
}

const IS_TOUCH = ("ontouchstart" in window) || (navigator.maxTouchPoints || 0) > 0;
function _kidify(text) {
  // Normalize copy for the input device: on the phone she TAPS, on a desktop
  // she CLICKS — flip whichever direction the content came in with.
  if (typeof text !== "string") return text;
  if (IS_TOUCH) {
    return text
      .replace(/\bClick\b/g, "Tap")
      .replace(/\bclick\b/g, "tap")
      .replace(/\bCLICK\b/g, "TAP");
  }
  return text
    .replace(/\bTap\b/g, "Click")
    .replace(/\btap\b/g, "click")
    .replace(/\bTAP\b/g, "CLICK");
}

// Map the kid's current theme to one or two emojis we use as "countable objects".
const THEME_EMOJI = {
  unicorns: ["🦄", "🌈"],
  mermaids: ["🧜‍♀️", "🐚"],
  dinos:    ["🦕", "🦖"],
  bluey:    ["🐶", "🦴"],
  space:    ["🚀", "🌟"],
  cats:     ["🐱", "🐾"],
  horses:   ["🐴", "🍎"],
  default:  ["⭐", "✨"],
};
function themeEmoji() {
  const t = (document.body.className.match(/theme-([a-z]+)/) || [])[1];
  return (THEME_EMOJI[t] || THEME_EMOJI.default)[0];
}

// Common-noun -> emoji lookup, used to illustrate sight words, phonics, and
// keywords inside reading-comp paragraphs. Order matters — longer words first.
const WORD_EMOJI = {
  // animals
  cat:"🐱", dog:"🐶", bird:"🐦", fish:"🐟", frog:"🐸", duck:"🦆", bear:"🐻",
  pig:"🐷", cow:"🐮", horse:"🐴", lion:"🦁", tiger:"🐯", monkey:"🐵", mouse:"🐭",
  rabbit:"🐰", bunny:"🐰", owl:"🦉", whale:"🐳", dolphin:"🐬", shark:"🦈",
  butterfly:"🦋", bee:"🐝", snake:"🐍", spider:"🕷️", ant:"🐜", dinosaur:"🦕",
  unicorn:"🦄", penguin:"🐧", elephant:"🐘", crocodile:"🐊", chicken:"🐔",
  // food
  apple:"🍎", banana:"🍌", orange:"🍊", grape:"🍇", strawberry:"🍓", lemon:"🍋",
  pizza:"🍕", cookie:"🍪", cake:"🍰", icecream:"🍦", milk:"🥛", bread:"🍞",
  egg:"🥚", carrot:"🥕", corn:"🌽", honey:"🍯", candy:"🍬", donut:"🍩",
  // nature
  sun:"☀️", moon:"🌙", star:"⭐", cloud:"☁️", rain:"🌧️", snow:"❄️",
  rainbow:"🌈", fire:"🔥", water:"💧", tree:"🌳", flower:"🌸", leaf:"🍃",
  mountain:"⛰️", ocean:"🌊", river:"🏞️", beach:"🏖️", earth:"🌎", world:"🌎",
  // things
  ball:"⚽", car:"🚗", bus:"🚌", truck:"🚚", train:"🚆", plane:"✈️", boat:"⛵",
  rocket:"🚀", bike:"🚲", house:"🏠", school:"🏫", hospital:"🏥", store:"🏬",
  book:"📚", pen:"🖊️", pencil:"✏️", paper:"📄", clock:"⏰", phone:"📱",
  // body / sel
  heart:"❤️", smile:"😊", happy:"😊", sad:"😢", angry:"😠", scared:"😨",
  surprised:"😲", love:"💖", friend:"🤝", hug:"🤗", family:"👨‍👩‍👧",
  hand:"✋", eye:"👁️", ear:"👂", nose:"👃", mouth:"👄", foot:"🦶",
  // weather / science
  hot:"🔥", cold:"🥶", wind:"💨", storm:"⛈️", lightning:"⚡", tornado:"🌪️",
  // misc kid faves
  music:"🎵", song:"🎶", dance:"💃", game:"🎮", toy:"🧸", gift:"🎁", party:"🎉",
};

function findWordIcon(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  // Try exact words first, then substring fallback.
  const words = lower.match(/\b[a-z]+\b/g) || [];
  for (const w of words) if (WORD_EMOJI[w]) return WORD_EMOJI[w];
  for (const w of words) for (const k in WORD_EMOJI) if (w.startsWith(k) || k.startsWith(w)) return WORD_EMOJI[k];
  return null;
}

// Draw a kid-friendly analog clock (teaching style: long blue minute hand,
// short red hour hand). Used by time activities that carry screen.clock {h,m}.
function makeClock(clock) {
  const h = Number(clock.h) || 12, m = Number(clock.m) || 0;
  const size = 200, c = size / 2, r = c - 10;
  const pt = (ang, len) => {
    const a = (ang - 90) * Math.PI / 180;
    return [c + len * Math.cos(a), c + len * Math.sin(a)];
  };
  let marks = "";
  for (let i = 1; i <= 12; i++) {
    const [nx, ny] = pt(i * 30, r - 20);
    marks += `<text x="${nx}" y="${ny + 7}" text-anchor="middle" font-size="21" font-weight="800" fill="#23405a" font-family="inherit">${i}</text>`;
  }
  const [mx, my] = pt(m * 6, r - 30);
  const [hx, hy] = pt(((h % 12) + m / 60) * 30, r - 62);
  const wrap = document.createElement("div");
  wrap.className = "question-visual";
  wrap.innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" width="200" height="200" style="filter: drop-shadow(0 8px 14px rgba(0,0,0,0.18));">
      <circle cx="${c}" cy="${c}" r="${r}" fill="#ffffff" stroke="#23405a" stroke-width="7"/>
      ${marks}
      <line x1="${c}" y1="${c}" x2="${mx}" y2="${my}" stroke="#2f7bd9" stroke-width="7" stroke-linecap="round"/>
      <line x1="${c}" y1="${c}" x2="${hx}" y2="${hy}" stroke="#e2554d" stroke-width="10" stroke-linecap="round"/>
      <circle cx="${c}" cy="${c}" r="8" fill="#23405a"/>
    </svg>`;
  return wrap;
}

// Draw real US coins (sized like the real things relative to each other).
function makeCoins(coins) {
  const SPEC = {
    quarter: { r: 30, fill: "#d7dde3", edge: "#9aa5ae", label: "25¢" },
    dime:    { r: 22, fill: "#dde2e8", edge: "#9aa5ae", label: "10¢" },
    nickel:  { r: 26, fill: "#d2d8de", edge: "#9aa5ae", label: "5¢" },
    penny:   { r: 24, fill: "#e3a06a", edge: "#b06f3a", label: "1¢" },
  };
  const wrap = document.createElement("div");
  wrap.className = "question-visual";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;";
  for (const [name, count] of coins) {
    const spec = SPEC[name]; if (!spec) continue;
    for (let i = 0; i < count; i++) {
      const d = spec.r * 2 + 8;
      const el = document.createElement("span");
      el.innerHTML = `<svg width="${d}" height="${d}" viewBox="0 0 ${d} ${d}" style="filter: drop-shadow(0 4px 6px rgba(0,0,0,0.2));">
        <circle cx="${d/2}" cy="${d/2}" r="${spec.r}" fill="${spec.fill}" stroke="${spec.edge}" stroke-width="4"/>
        <text x="${d/2}" y="${d/2 + 6}" text-anchor="middle" font-size="${spec.r * 0.62}" font-weight="800" fill="#3b4754" font-family="inherit">${spec.label}</text>
      </svg>`;
      row.appendChild(el);
    }
  }
  wrap.appendChild(row);
  return wrap;
}

// Fraction pies: filled/total slices, one pie per fraction (labeled when 2+).
function makeFractionPies(fractions) {
  const wrap = document.createElement("div");
  wrap.className = "question-visual";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:26px;justify-content:center;align-items:flex-end;";
  for (const [num, den] of fractions) {
    const size = fractions.length > 1 ? 130 : 170, c = size / 2, r = c - 6;
    let slices = "";
    for (let i = 0; i < den; i++) {
      const a0 = (i / den) * 2 * Math.PI - Math.PI / 2;
      const a1 = ((i + 1) / den) * 2 * Math.PI - Math.PI / 2;
      const x0 = c + r * Math.cos(a0), y0 = c + r * Math.sin(a0);
      const x1 = c + r * Math.cos(a1), y1 = c + r * Math.sin(a1);
      const large = 1 / den > 0.5 ? 1 : 0;
      slices += `<path d="M${c},${c} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z"
        fill="${i < num ? "#22a877" : "#f2f2ee"}" stroke="#23405a" stroke-width="3"/>`;
    }
    const cell = document.createElement("span");
    cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px;";
    cell.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="filter: drop-shadow(0 6px 10px rgba(0,0,0,0.15));">${slices}</svg>` +
      (fractions.length > 1 ? `<span style="font-weight:800;font-size:22px;color:#23405a;">${num}/${den}</span>` : "");
    row.appendChild(cell);
  }
  wrap.appendChild(row);
  return wrap;
}

// One big friendly shape for "what shape is this?" questions.
function makeShape(shape) {
  const size = 170, c = size / 2;
  const SHAPES = {
    circle:    `<circle cx="${c}" cy="${c}" r="70" fill="#4ea8ff" stroke="#23405a" stroke-width="5"/>`,
    square:    `<rect x="20" y="20" width="130" height="130" fill="#22a877" stroke="#23405a" stroke-width="5"/>`,
    rectangle: `<rect x="10" y="45" width="150" height="80" fill="#ffb64d" stroke="#23405a" stroke-width="5"/>`,
    triangle:  `<polygon points="${c},18 152,152 18,152" fill="#e2554d" stroke="#23405a" stroke-width="5" stroke-linejoin="round"/>`,
    star:      `<polygon points="85,10 104,60 158,62 116,96 131,148 85,118 39,148 54,96 12,62 66,60" fill="#f5c518" stroke="#23405a" stroke-width="5" stroke-linejoin="round"/>`,
    heart:     `<path d="M85 150 C 20 100, 20 45, 55 35 C 75 30, 85 48, 85 55 C 85 48, 95 30, 115 35 C 150 45, 150 100, 85 150 Z" fill="#ff6b9d" stroke="#23405a" stroke-width="5"/>`,
    oval:      `<ellipse cx="${c}" cy="${c}" rx="75" ry="50" fill="#b78ae8" stroke="#23405a" stroke-width="5"/>`,
    diamond:   `<polygon points="${c},14 150,${c} ${c},156 20,${c}" fill="#5fd3a2" stroke="#23405a" stroke-width="5" stroke-linejoin="round"/>`,
  };
  const svg = SHAPES[String(shape).toLowerCase()];
  if (!svg) return null;
  const wrap = document.createElement("div");
  wrap.className = "question-visual";
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="filter: drop-shadow(0 8px 14px rgba(0,0,0,0.18));">${svg}</svg>`;
  return wrap;
}

// Generate a visual diagram for the question. Returns HTMLElement or null.
function buildQuestionVisual(s) {
  if (s && s.clock) return makeClock(s.clock);
  if (s && s.coins) return makeCoins(s.coins);
  if (s && s.fractions) return makeFractionPies(s.fractions);
  if (s && s.shape) return makeShape(s.shape);
  if (!s || !s.title) return null;
  if (s.type === "trace" || s.type === "spell") return null;

  const title = s.title;
  const prompt = s.prompt || "";
  const skill = (s.skill || "").toLowerCase();
  const fullText = (title + " " + prompt);
  const emoji = themeEmoji();
  const wrap = document.createElement("div");
  wrap.className = "question-visual";

  // ── ADDITION  "N + M [= ?]"
  let m = title.match(/^\s*(\d{1,2})\s*\+\s*(\d{1,2})/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a + b <= 24 && a <= 12 && b <= 12) {
      wrap.append(makeGroup(emoji, a), opNode("+"), makeGroup(emoji, b));
      return wrap;
    }
  }
  // ── SUBTRACTION  "N − M"  (cross out the subtrahend)
  m = title.match(/^\s*(\d{1,2})\s*[-−–]\s*(\d{1,2})/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a <= 20 && b <= a) {
      wrap.append(makeGroup(emoji, a, "", b));
      return wrap;
    }
  }
  // ── MULTIPLICATION / GROUPS OF  "N groups of M" or "N × M"
  m = title.match(/^\s*(\d{1,2})\s*(?:groups?\s*of|×|x|\*)\s*(\d{1,2})/i);
  if (m) {
    const groups = +m[1], per = +m[2];
    if (groups * per <= 30 && groups <= 6 && per <= 8) {
      for (let i = 0; i < groups; i++) wrap.append(makeGroup(emoji, per, "v-group"));
      return wrap;
    }
  }
  // ── DIVISION  "N ÷ M"  (N items shared into M groups)
  m = title.match(/^\s*(\d{1,2})\s*[÷\/]\s*(\d{1,2})/);
  if (m) {
    const total = +m[1], groups = +m[2];
    if (groups > 0 && total <= 24 && groups <= 6 && total % groups === 0) {
      const per = total / groups;
      for (let i = 0; i < groups; i++) wrap.append(makeGroup(emoji, per, "v-group"));
      return wrap;
    }
  }
  // ── COMPARISON  "N > M" / "N < M" / "N = M"
  m = title.match(/^\s*(\d{1,2})\s*([><=])\s*(\d{1,2})/);
  if (m) {
    const a = +m[1], op = m[2], b = +m[3];
    if (a <= 12 && b <= 12) {
      wrap.append(makeGroup(emoji, a), opNode(op), makeGroup(emoji, b));
      return wrap;
    }
  }
  // ── SKIP-COUNT  sequence "2, 4, 6, ?" — show each number as a tally of dots
  if (/^[\s,?\-\d]+$/.test(title) && title.includes(",")) {
    const parts = title.split(/[,\s]+/).filter(Boolean);
    if (parts.length >= 3 && parts.length <= 6) {
      for (const p of parts) {
        const n = parseInt(p, 10);
        if (Number.isFinite(n) && n > 0 && n <= 20) {
          wrap.append(makeGroup("●", n, "v-tally"));
        } else {
          const q = document.createElement("span"); q.className = "v-op"; q.textContent = "?";
          wrap.append(q);
        }
      }
      return wrap;
    }
  }
  // ── PLACE VALUE  "23 = ? tens + ? ones" — show ten-frames
  m = fullText.match(/(\d{2,3})\s*=\s*\?\s*tens?\s*\+\s*\?\s*ones?/i)
   || fullText.match(/how many tens in (\d{1,3})/i)
   || (skill.includes("place") && title.match(/(\d{2,3})/));
  if (m) {
    const n = +m[1];
    if (n <= 99) {
      const tens = Math.floor(n / 10), ones = n % 10;
      for (let i = 0; i < tens; i++) wrap.append(makeTenFrame());
      if (ones > 0) wrap.append(makeGroup("●", ones, "v-ones"));
      return wrap;
    }
  }
  // ── COUNTING (image_word) — title already has visual emojis, skip
  if (s.type === "image_word") return null;

  // ── SIGHT WORDS / PHONICS / single-word — try to find a matching icon for the word
  if (s.type === "sight_words" || s.type === "phonics" || s.type === "word") {
    const icon = findWordIcon(title) || findWordIcon(prompt) || emoji;
    const ic = document.createElement("span");
    ic.className = "v-sight-icon";
    ic.textContent = icon;
    wrap.append(ic);
    return wrap;
  }

  // ── READING COMP — find a keyword in the paragraph and show 1-2 icons
  if (s.type === "reading_comp" || s.type === "story") {
    const icon = findWordIcon(fullText);
    if (!icon) return null;
    const ic = document.createElement("span");
    ic.className = "v-sight-icon";
    ic.textContent = icon;
    wrap.append(ic);
    return wrap;
  }

  // Fallback: if the prompt mentions a concrete word we know, show its icon.
  const fallbackIcon = findWordIcon(fullText);
  if (fallbackIcon) {
    const ic = document.createElement("span");
    ic.className = "v-sight-icon";
    ic.textContent = fallbackIcon;
    wrap.append(ic);
    return wrap;
  }
  return null;
}

function makeGroup(emoji, n, cls, strikeCount) {
  const g = document.createElement("span");
  g.className = "v-emoji-group " + (cls || "");
  for (let i = 0; i < n; i++) {
    const e = document.createElement("span");
    e.className = "v-emoji";
    if (strikeCount && i >= n - strikeCount) e.classList.add("v-strike");
    e.textContent = emoji;
    e.style.animationDelay = (i * 40) + "ms";
    g.appendChild(e);
  }
  return g;
}
function opNode(sym) {
  const o = document.createElement("span");
  o.className = "v-op";
  o.textContent = sym;
  return o;
}
function makeTenFrame() {
  // A 2x5 grid of dots = 10. Helps kids see "tens" at a glance.
  const f = document.createElement("div");
  f.className = "v-tenframe";
  for (let i = 0; i < 10; i++) {
    const d = document.createElement("span");
    d.className = "v-dot";
    d.style.animationDelay = (i * 30) + "ms";
    f.appendChild(d);
  }
  return f;
}

function renderActivity(p) {
  STATE.retried = false;          // fresh retry for every activity
  STATE.renderedAt = Date.now();  // latency clock starts when she can see it
  // Every new question starts at the top — a scrolled-down stage from the
  // previous activity must never hide the new bubble/title.
  const stageEl = $("stage");
  if (stageEl) stageEl.scrollTop = 0;
  if (p) p.say = _kidify(p.say);
  if (p?.screen) {
    p.screen.title = _kidify(p.screen.title);
    p.screen.prompt = _kidify(p.screen.prompt);
  }
  $("said").textContent = p.say || "";
  // Bubble itself is tappable to repeat
  const bubble = document.querySelector(".bubble");
  if (bubble && !bubble.__wired) {
    bubble.__wired = true;
    bubble.style.cursor = "pointer";
    bubble.addEventListener("click", repeatCurrent);
    bubble.title = "Click to hear again";
  }
  const c = $("content");
  c.innerHTML = "";
  const s = p.screen || {};
  const theme = s.theme || STATE.theme;
  if (theme && theme !== STATE.theme) {
    document.body.className = "";
    document.body.classList.add(`theme-${theme}`);
    STATE.theme = theme;
  }

  if (s.title) {
    const h = document.createElement("h2");
    h.className = "title-big";
    if (s.type === "image_word") h.classList.add("count-card");
    // Reading-comp paragraphs are sentences, not single words — render readable, not giant.
    if (s.type === "reading_comp" || (s.title && s.title.length > 60)) {
      h.classList.add("paragraph");
    }
    h.textContent = s.title;
    c.appendChild(h);

    // Auto-visual layer: render emoji groups under the title that illustrate
    // the question (math: actual countable objects; sight words: themed icon).
    const visual = buildQuestionVisual(s);
    if (visual) c.appendChild(visual);
  }
  if (s.prompt) {
    const pr = document.createElement("p");
    pr.className = "prompt-line";
    pr.textContent = s.prompt;
    c.appendChild(pr);
  }
  if (s.scene) {
    const se = document.createElement("div");
    se.className = "scene-emojis";
    se.textContent = s.scene;
    c.appendChild(se);
  }

  if (s.type === "trace") {
    const box = document.createElement("div");
    box.className = "trace-box";
    box.innerHTML = `<div class="ghost">${s.answer || "A"}</div><canvas></canvas>`;
    c.appendChild(box);
    setupTrace(box);
  }

  if (Array.isArray(s.items) && s.items.length) {
    const opts = document.createElement("div");
    // Even layout: short answers get a uniform grid, long answers stack.
    const longText = s.items.some(it =>
      String(typeof it === "string" ? it : (it.label || it.word || it.value || "")).length > 16);
    opts.className = "options " + (longText ? "options-stack" : "options-grid");
    s.items.forEach(item => {
      const b = document.createElement("button");
      b.className = "option-btn";
      // Tolerate plain strings OR objects like {label, word, emoji, image}
      const label = (typeof item === "string")
        ? item
        : (item.label || item.word || item.text || item.emoji || item.value || JSON.stringify(item));
      const value = (typeof item === "string")
        ? item
        : (item.word || item.value || item.label || label);
      const lbl = document.createElement("span");
      lbl.className = "option-label";
      lbl.textContent = label;
      // Speaker zone removed — the WHOLE button chooses the answer. Listening
      // happens through the single "Read to me" pill under the options.
      b.appendChild(lbl);
      b.addEventListener("click", () => onTap(value, b));
      opts.appendChild(b);
    });
    c.appendChild(opts);

    // One clear "listen" control for pre-readers: reads every choice in order.
    // Two easy words on it — these are kids reading it.
    if (STATE.voiceOn && s.items.length && p.expects === "tap") {
      const hear = document.createElement("button");
      hear.className = "hear-btn";
      hear.setAttribute("aria-label", "Read the choices to me");
      hear.innerHTML = `<span>🔊</span><span>Read to me</span>`;
      hear.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (hear.__busy) return;
        hear.__busy = true;
        hear.classList.add("speaking");
        try {
          for (const item of s.items) {
            const say_ = (typeof item === "string") ? item
              : (item.word || item.value || item.label || "");
            if (STATE.grading) break;      // she answered mid-readout — stop
            await speak(String(say_));
          }
        } finally {
          hear.__busy = false;
          hear.classList.remove("speaking");
        }
      });
      c.appendChild(hear);
    }

    // Fit-to-FILL: buttons are equal-size grid cells; grow each label until it
    // would overflow its cell, then unify the whole set to the smallest fit so
    // every answer matches. Fills big tablet buttons, never spills on phones.
    requestAnimationFrame(() => {
      const labels = Array.from(opts.querySelectorAll('.option-label'));
      if (!labels.length) return;
      let unified = Infinity;
      labels.forEach(lbl => {
        const btn = lbl.closest('button');
        const maxW = btn.clientWidth - 28;
        const maxH = btn.clientHeight - 18;
        const cap = Math.min(Math.floor(maxH * 0.8), 120);
        let fs = 12;
        lbl.style.fontSize = fs + 'px';
        while (fs + 2 <= cap) {
          lbl.style.fontSize = (fs + 2) + 'px';
          if (lbl.scrollWidth > maxW || lbl.scrollHeight > maxH) { lbl.style.fontSize = fs + 'px'; break; }
          fs += 2;
        }
        unified = Math.min(unified, fs);
      });
      labels.forEach(lbl => { lbl.style.fontSize = unified + 'px'; });
    });
  }

  // Safety net: if backend forgot tap items, auto-skip to the next activity
  // instead of showing a half-broken screen the kid (or video viewers) sees.
  if (!Array.isArray(s.items) && p.expects !== "trace") {
    console.warn("[render] activity missing items, auto-skipping:", p);
    setTimeout(() => { try { nextActivity(); } catch(_) {} }, 300);
    const skip = document.createElement("p");
    skip.className = "prompt-line";
    skip.textContent = "...";
    c.appendChild(skip);
  }
}

function setupTrace(box) {
  const canvas = box.querySelector("canvas");
  const rect = box.getBoundingClientRect();
  canvas.width = rect.width; canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  ctx.lineWidth = 14; ctx.lineCap = "round"; ctx.strokeStyle = "#1fa06b";
  let drawing = false;
  let hasDrawn = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {x: t.clientX - r.left, y: t.clientY - r.top};
  };
  const start = (e) => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); hasDrawn = true; if (doneBtn.disabled) doneBtn.disabled = false; e.preventDefault(); };
  const end = () => { drawing = false; };
  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  canvas.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start);
  canvas.addEventListener("touchmove", move);
  canvas.addEventListener("touchend", end);

  // Append explicit Done button — kid finishes the whole letter, then taps Done.
  const wrap = document.createElement("div");
  wrap.className = "trace-actions";
  const doneBtn = document.createElement("button");
  doneBtn.className = "done-btn";
  doneBtn.textContent = "\u2713 Done";
  doneBtn.disabled = true;
  let traceFired = false;
  doneBtn.addEventListener("click", () => {
    if (!hasDrawn || traceFired) return;
    traceFired = true;
    doneBtn.disabled = true;
    onTraceDone();
  });
  wrap.appendChild(doneBtn);
  box.parentNode.insertBefore(wrap, box.nextSibling);
}
function onTraceDone() {
  if (STATE.grading) return;
  STATE.grading = true;  // claim the gate now, before the 600ms beat
  // give a beat then advance
  setTimeout(() => finalize("traced", true), 600);
}

function answersMatch(value, expected) {
  // Exact match, or numeric match for math ("7" vs "7 "). NO prefix matching:
  // startsWith let "they" pass for "the" — wrong answers were graded correct.
  const v = String(value).trim().toLowerCase();
  const e = String(expected).trim().toLowerCase();
  if (v === e) return true;
  const numV = (v.match(/^-?\d+$/) || [])[0];
  const numE = (e.match(/^-?\d+$/) || [])[0];
  return !!(numV && numE && numV === numE);
}

function attemptLatency() {
  return STATE.renderedAt ? Math.max(0, Date.now() - STATE.renderedAt) : 0;
}

function postAttempt(got, correct) {
  // Returns the server response — a correct answer comes back with the
  // persistent sticker it earned, so the HUD can pop the real one.
  return fetch("/api/attempt", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      session_id: STATE.sessionId,
      skill: STATE.current?.skill,
      difficulty: STATE.current?.difficulty,
      prompt: STATE.current?.screen?.title || STATE.current?.screen?.prompt || "",
      expected: STATE.current?.screen?.answer || "",
      got,
      correct,
      latency_ms: attemptLatency(),
      theme: STATE.theme,
    }),
  }).then(r => r.json()).catch(e => { console.warn(e); return {}; });
}

const TRY_AGAIN_HINTS = [
  "Not that one — look again, you got this!",
  "Hmm, try a different one!",
  "So close! Pick another answer.",
  "Take your time and look at each one.",
  "Good thinking — now try another!",
];

async function onTap(value, btn) {
  if (STATE.grading) return;
  resetDrift();
  const expected = String(STATE.current?.screen?.answer ?? "").trim();
  const correct = answersMatch(value, expected);

  if (correct) {
    // LOCK — first correct tap wins; everything else freezes until next render.
    STATE.grading = true;
    if (window.SFX) SFX.play("correct");
    document.querySelectorAll("#content .options button, #content .trace-box")
      .forEach(el => { el.style.pointerEvents = "none"; if (el !== btn) el.style.opacity = "0.65"; });
    btn.classList.add("right");
    await sleep(450);
    finalize(value, true);
    return;
  }

  if (!STATE.retried) {
    // REAL try-again: kill just this option and let her actually retry —
    // the encouragement phrases finally mean what they say.
    STATE.retried = true;
    STATE.wrongStreak++; STATE.rightStreak = 0;   // frustration signal stays honest
    if (window.SFX) SFX.play("wrong");
    postAttempt(value, false);                     // record the miss
    btn.classList.add("wrong");
    btn.style.pointerEvents = "none";
    btn.style.opacity = "0.4";
    const hint = TRY_AGAIN_HINTS[Math.floor(Math.random() * TRY_AGAIN_HINTS.length)];
    $("said").textContent = hint;
    speakNow(hint);
    startDriftTimer();
    return;
  }

  // Second miss: reveal the right answer ON the options (so it lands on the
  // question she's looking at, not spoken over the next one), then move on.
  STATE.grading = true;
  if (window.SFX) SFX.play("reveal");
  document.querySelectorAll("#content .options button, #content .trace-box")
    .forEach(el => { el.style.pointerEvents = "none"; });
  btn.classList.add("wrong");
  document.querySelectorAll("#content .options button").forEach(b => {
    const lbl = b.querySelector(".option-label");
    if (lbl && answersMatch(lbl.textContent, expected)) b.classList.add("reveal");
    else if (b !== btn) b.style.opacity = "0.4";
  });
  // Say the answer NOW, while the kid is looking at the highlighted option —
  // not over the next question.
  speakNow(ttsFriendly(`It was ${expected}.`));
  await sleep(1400);   // let the reveal land while the question is still up
  finalize(value, false);
}

async function onHeard(text) {
  resetDrift();
  const expected = String(STATE.current?.screen?.answer ?? "").trim();
  // Send to backend for fuzzy grading
  let correct = false, feedback = "";
  try {
    const r = await fetch("/api/grade", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify({expected, got: text, skill: STATE.current?.skill}),
    });
    const j = await r.json();
    correct = !!j.correct;
    feedback = j.feedback || "";
  } catch (e) { correct = false; }
  finalize(text, correct, feedback);
}

// Bound any awaited promise so a stalled speak()/showFactToast() can't lock
// the game forever. Resolves on the underlying promise OR after `ms`, whichever
// comes first. Kid never gets stuck waiting on audio/toast that didn't fire.
function withDeadline(p, ms) {
  return Promise.race([p, new Promise(r => setTimeout(r, ms))]);
}

async function finalize(got, correct, feedback) {
  // Resolution of one activity (correct tap, second miss, or trace done).
  // Owns the lock through the advance; the first-miss retry never gets here.
  STATE.grading = true;
  document.querySelectorAll("#content .options button, #content .trace-box")
    .forEach(el => { el.style.pointerEvents = "none"; });

  // Persist the final outcome; a correct answer comes back with a sticker.
  const resp = await withDeadline(postAttempt(got, correct), 2500) || {};

  STATE.history.push({
    skill: STATE.current?.skill,
    difficulty: STATE.current?.difficulty,
    correct,
    prompt: STATE.current?.screen?.title || "",
  });

  // VISIBLE feedback — flash a card overlay and update bubble FIRST, then play audio
  const phrase = correct ? pickPraise(feedback) : pickGentleTry(feedback);
  $("said").textContent = phrase;
  flashFeedbackCard(correct, correct ? "✓" : "Next one!");

  if (correct) {
    STATE.rightStreak++; STATE.wrongStreak = 0;
    addSticker(resp.sticker);
  } else {
    STATE.rightStreak = 0;
    // Queue this exact question for a re-ask ~3 activities from now.
    // Only once — a twice-missed question shouldn't loop forever.
    if (STATE.current && !STATE.current._comeback) {
      STATE.comeback = STATE.comeback || [];
      STATE.comeback.push({
        payload: {...STATE.current, _comeback: true,
                  say: "Remember this one? " + (STATE.current.say || "")},
        due: STATE.activitiesDone + 3,
      });
    }
  }
  STATE.activitiesDone++;

  // Tiny visual beat, then hop to the next question.
  // Audio + fact toast keep playing in the BACKGROUND over the new question.
  // Correct: cut leftover prompt audio so the praise starts instantly.
  // Wrong: queue behind the "It was X." reveal line so neither gets cut.
  (correct ? speakNow : speak)(phrase);        // fire and forget
  await sleep(correct ? 450 : 700);            // let the ✓ land; praise continues over next question

  // Streak celebration AFTER the praise line — short, doesn't block.
  if (correct && STATE.rightStreak >= 3) {
    bigCelebrate();
    STATE.rightStreak = 0;
    // no await — let the celebration play while the next question loads
  }

  // Quest: every finished activity is one rung up the treehouse — effort
  // counts, not just right answers (right answers are what earn stickers).
  if (advanceQuest()) {
    STATE.grading = false;
    questFinale();
    return;
  }

  // "Did you know..." facts are fully OFF (Matt 2026-07-07): the visual cards
  // were clutter and the spoken ones were confusing mid-lesson. The fact
  // library stays in the content packs in case a future settings toggle
  // brings them back as an opt-in.

  STATE.grading = false;
  nextActivity();
}

function flashFeedbackCard(correct, label) {
  const el = document.createElement("div");
  el.className = "fb-flash " + (correct ? "fb-yes" : "fb-no");
  el.textContent = label;
  document.body.appendChild(el);
  // Auto-clean
  setTimeout(() => el.remove(), 1400);
}

function pickPraise(extra) {
  const p = [
    "🎉 Yes!", "⭐ Nailed it!", "✨ You got it!", "🔥 Awesome!", "💥 Boom!", "🙌 Right on!",
    "🚀 Way to go!", "🧠 Brilliant!", "🎯 Bingo!", "✨ Sparkle work!", "🔥 You're on fire!",
    "🤩 Wow!", "🌟 Stellar!", "👀 Look at you go!", "🍪 Smart cookie!", "🖐 High five!",
    "👑 Magnificent!", "💪 Crushed it!", "🌈 Beautiful!", "🎯 Bullseye!", "🎊 Yes yes yes!",
    "🏆 Top notch!", "🪙 Pure gold!", "✅ That's the one!", "💎 Rock solid!", "💯 Perfect!",
    "💡 Lightbulb!", "💨 Whoosh!", "🧠 Big brain!", "🎯 Right on the dot!", "💥 Pow!",
    "🦄 Unicorn move!", "🚀 Blast off!", "🎈 Lifted off!", "🌟 Superstar!", "🥳 Party time!",
    "🦁 Lion smart!", "🐯 Tiger sharp!", "🦊 Foxy thinking!", "🐉 Dragon brain!", "🦅 Eagle eye!",
    "🎸 Rockstar!", "🎤 Mic drop!", "🎬 Take a bow!", "👏 Bravo!", "💐 Bouquet for you!",
    "🌻 Sun-bright!", "🍯 Sweet!", "🍓 Berry good!", "🍕 Slice of brilliance!", "🍩 Donut doubt it!",
    "🌟 Starshine!", "✨ Magic!", "🪄 Spellbound!", "🧚 Fairy-tale work!", "🌙 Moonshot!",
    "☀️ Sunshine smart!", "⚡ Zap! Got it!", "🌊 Wave of wow!", "🏄 Surf's up!", "🎯 Dead on!",
    "🎵 In tune!", "🥁 Drumroll yes!", "🎺 Trumpet it!", "🎻 Sweet music!", "🧨 Mind blown!",
    "🪅 Piñata burst!", "🌋 Volcano power!", "🦋 Butterfly brain!", "🐬 Dolphin clever!", "🐢 Wise turtle!",
    "🐝 Bee brilliant!", "🦉 Owl smart!", "🐧 Penguin perfect!", "🦒 Tall thinking!", "🦓 Striped genius!",
    "🌈 Rainbow right!", "☁️ Cloud nine!", "🍀 Lucky pick!", "🪷 Lotus level!", "🌺 Tropical smart!",
    "🥇 Gold medal!", "🏅 Hall of fame!", "🎖️ Honors!", "🎓 Class act!", "📚 Book smart!",
    "✏️ Sharp pencil!", "🔑 Key thinker!", "🔦 Bright spark!", "🎨 Picasso brain!", "🖌️ Stroke of genius!",
    "🚂 Choo choo champ!", "🛸 Out of this world!", "🛼 Roll on!", "⛷️ Downhill speed!", "🏂 Air time!",
    "🤸 Flip and fly!", "🤾 Goal!", "⚽ Score!", "🥋 Black belt brain!", "🏹 Right on target!",
    "🌠 Shooting star!", "🌌 Galaxy good!", "🦕 Dino strong!", "🐙 Eight thumbs up!"
  ];
  return (extra ? extra + " " : "") + p[Math.floor(Math.random()*p.length)];
}
function pickGentleTry(extra) {
  const p = [
    "💪 Almost!", "🌱 Good try!", "🤏 So close!", "🌟 Close one!",
    "🤔 Tricky one — let's look again.",
    "🧠 Brain warming up — go again.",
    "💭 You're thinking — that's what counts.",
    "🐢 Big question — take your time.",
    "👀 Right idea — give it one more peek.",
    "🫶 No worries — let's try again together.",
    "🌈 It happens — one more shot.",
    "🦊 Sneaky one — try once more.",
    "💪 You got this — try again.",
    "🪜 Almost there — let's check it once more.",
    "✨ Cool — pick again.",
    "👁️ Hmm, take another look.",
    "🌻 Keep going — you're growing!",
    "🐌 Slow and steady — try again.",
    "🛟 Safety net here — try once more.",
    "🐝 Buzz again — give it another go.",
    "🌊 Ride the wave — try once more.",
    "🚪 Try the next door!",
    "🧩 One more puzzle piece — try again.",
    "🪶 Lightly does it — pick again.",
    "🔁 Loop back, try again.",
    "🍀 Lucky try coming up.",
    "🌷 Bloom again — give it another try.",
    "📖 Page two — try once more.",
    "🚲 Pedal again, you got it.",
    "🦉 Take a wise second look.",
    "🛌 Stretch, then try again.",
    "🌞 Bright eyes — pick again.",
    "🐢 Steady wins — one more time.",
    "🐬 Splash back in!",
    "🦋 Try a new flap.",
    "🦄 Magic still works — try again.",
    "🪀 Yo yo back — give it another try.",
    "🦘 Hop back, try again.",
    "🚀 Reset launch — try again.",
    "🎯 Aim and try again.",
    "🌬️ Take a breath — try again.",
    "🍓 Sweet idea — try once more.",
    "🧗 Climb again — you're close.",
    "🛹 Roll back, try again.",
    "🎈 Float back, try again.",
    "🐌 No rush — try again.",
    "🌿 Rooted in — try once more.",
    "🦁 Brave heart — try again.",
    "🐧 Waddle back — give it a go.",
    "🌌 Stars are watching — try again.",
    "🌳 Branch out — try again.",
    "🍵 Sip and think — pick again.",
    "🪞 Look again with fresh eyes.",
    "🐠 Swim around — try once more.",
    "🐰 Hop again, you got this!",
    "🐢 Inch closer — try again.",
    "🐝 Buzzing toward it — one more!",
    "🪴 Growing your smarts — try again.",
    "📐 Measure twice, tap again.",
    "🔭 Take a second look.",
    "🎒 Pack it in, try again.",
    "🎵 Hum it out — try again.",
    "🪁 Catch the wind — try once more.",
    "🧦 Pair it up — try again.",
    "🍂 Fall and rise — try again.",
    "🛶 Paddle back — try again.",
    "🐉 Mighty try — one more!",
    "🐢 Don't give up — try again.",
    "🐦 Tweet and try!",
    "🍋 Squeeze it again, you got this.",
    "🪅 Swing again!",
    "🎁 Unwrap it — try once more.",
    "🦔 Cozy try — one more.",
    "🐞 Lucky ladybug — try again.",
    "🌷 Spring back — try again.",
    "🦒 Stretch tall, try again.",
    "🦝 Sneaky one — try again.",
    "🌟 Almost shining — try again.",
    "🧙 One more wand wave!",
    "🥧 Bake it again, try once more.",
    "🐳 Big think — try again.",
    "🌊 Catch the next wave!",
    "🪨 Steady stone — try again.",
    "🧗 One more reach!",
    "🪂 Soft landing — try again.",
    "🛹 Push off again!",
    "🛼 Glide back — try once more.",
    "🚲 Hop on, try again.",
    "🚂 Chug along, try again.",
    "🛻 Reverse and try again.",
    "🚜 Plow forward — try again.",
    "🦓 Stripes of courage — try again.",
    "🐘 Memory check — try again.",
    "🐼 Calm try — one more!",
    "🦦 Otter you can do it!",
    "🦥 No rush, try again.",
    "🐿️ Squirrel sharp — try again.",
    "🦔 Roll back — try again.",
    "🐇 Quick hop, try again.",
    "🐸 Leap again!",
    "🦜 Squawk it — try once more.",
    "🌎 Spin and try once more."
  ];
  // The answer was already revealed visually + spoken on the question itself,
  // so no "The answer is X" here — it would land on the NEXT question.
  return (extra ? extra + " " : "") + p[Math.floor(Math.random()*p.length)];
}

function addSticker(earned) {
  // Show the sticker the server actually banked in her collection; fall back
  // to a random one if the request didn't make it back in time.
  const stickers = ["⭐","🌈","🎉","💖","🦋","🌟","🍭","🎈","🪄","✨","🍩","🌺"];
  const s = document.createElement("span");
  s.className = "sticker-pop";
  s.textContent = earned || stickers[Math.floor(Math.random()*stickers.length)];
  if (window.SFX) SFX.play("sticker");
  $("stickers").appendChild(s);
  // keep only last 8
  while ($("stickers").children.length > 8) $("stickers").removeChild($("stickers").firstChild);
}

function bigCelebrate() {
  STATE.celebrateCount = (STATE.celebrateCount || 0) + 1;  // observable for tests
  const phrases = [
    "AMAZING!","WOOHOO!","SUPERSTAR!","INCREDIBLE!","YOU ROCK!",
    "ROCKSTAR!","BRILLIANT!","FANTASTIC!","WONDERFUL!","OUTSTANDING!",
    "SPECTACULAR!","MAGNIFICENT!","STELLAR!","BRAVO!","LEGEND!",
    "GENIUS!","HOORAY!","WHOA!","BAM!","EPIC!",
    "CHAMPION!","TRIUMPH!","MARVELOUS!","DAZZLING!","TREMENDOUS!"
  ];
  const ct = $("celebrate-text");
  // tour audits worst-case: always the longest word
  ct.textContent = window.__BF_UITOUR ? "SPECTACULAR!" : phrases[Math.floor(Math.random()*phrases.length)];
  // the pop animation peaks at 1.2x — shrink so even the peak stays on screen
  ct.style.fontSize = "";
  requestAnimationFrame(() => {
    const max = window.innerWidth * 0.78;
    if (ct.scrollWidth > max) {
      ct.style.fontSize = Math.floor(parseFloat(getComputedStyle(ct).fontSize) * max / ct.scrollWidth) + "px";
    }
  });
  cls($("celebrate"), "show", true);
  cls($("celebrate"), "hidden", false);
  if (window.SFX) SFX.play("fanfare");
  fireConfetti();
  setTimeout(() => {
    cls($("celebrate"), "show", false);
    cls($("celebrate"), "hidden", true);
  }, 1800);
}

// ---- Confetti ----
function fireConfetti() {
  const canvas = $("confetti");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width = window.innerWidth;
  const H = canvas.height = window.innerHeight;
  const colors = ["#ff3aa1","#6b4eff","#00b894","#ffd166","#4ea8ff","#ff8a4d"];
  const pieces = [];
  for (let i = 0; i < 140; i++) {
    pieces.push({
      x: W/2 + (Math.random()-0.5)*200,
      y: H/2 + (Math.random()-0.5)*100,
      vx: (Math.random()-0.5) * 18,
      vy: -Math.random() * 16 - 6,
      g: 0.5 + Math.random()*0.4,
      r: Math.random()*Math.PI,
      vr: (Math.random()-0.5)*0.3,
      size: 8 + Math.random()*8,
      color: colors[Math.floor(Math.random()*colors.length)],
    });
  }
  let t0 = performance.now();
  function frame(t) {
    const dt = Math.min(40, t - t0); t0 = t;
    ctx.clearRect(0,0,W,H);
    let alive = 0;
    for (const p of pieces) {
      p.vy += p.g;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      if (p.y < H + 40) alive++;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size*0.5);
      ctx.restore();
    }
    if (alive > 0) requestAnimationFrame(frame);
    else ctx.clearRect(0,0,W,H);
  }
  requestAnimationFrame(frame);
}

// (Floating theme creatures removed — they confused counting activities.)

function flashFeedback(msg, ok) {
  $("said").textContent = msg;
}

// ---- Drift detection ----
// Wait for the kid's answer — never auto-advance. After a long pause we offer
// a gentle nudge but the question stays on screen until they tap.
function startDriftTimer() {
  resetDrift();
  STATE.driftTimer = setTimeout(async () => {
    await speak(_kidify("Take your time. Click the answer when you're ready."));
  }, 30000);
}
function resetDrift() {
  if (STATE.driftTimer) { clearTimeout(STATE.driftTimer); STATE.driftTimer = null; }
}

// ---- Break / Home ----
async function goHome() {
  resetDrift();
  stopFactTicker();
  speechSynthesis.cancel();
  // Also stop the Piper WAV pipeline — otherwise the tutor keeps talking
  // on the home screen after "break".
  _tts_queue = [];
  if (_tts_audio) { try { _tts_audio.pause(); } catch(_){} }
  _tts_playing = false;
  if (window.BF && BF.nativeTTS) BF.stopSpeak();
  clearBackdrop();
  if (STATE.sessionId) {
    const seconds = Math.round((Date.now() - STATE.startedAt) / 1000);
    fetch("/api/session/end", {
      method:"POST",
      headers:{"content-type":"application/json"},
      body: JSON.stringify({session_id: STATE.sessionId, seconds, activities: STATE.activitiesDone}),
    }).catch(()=>{});
  }
  STATE.sessionId = null;
  STATE.prefetched = null;
  STATE.focusSkill = null;
  STATE.focusLabel = "";
  cls($("lesson"), "active", false);
  cls($("welcome"), "active", true);
  document.body.className = "";
}

function advance() { nextActivity(); }

// ============================================================
// Brainforest Forever — 60-day free trial, then a one-time $0.99
// unlock (StoreKit via the bfIAP bridge). Kids-category compliant:
// the purchase sits behind a parental gate, with Restore Purchases.
// ============================================================
(function () {
  const TRIAL_DAYS = 60;
  const iapNative = window.webkit && webkit.messageHandlers && webkit.messageHandlers.bfIAP;
  const send = (cmd) => { try { iapNative && iapNative.postMessage({ cmd }); } catch (_) {} };

  let PRICE = "$0.99";
  let pendingBuy = null, pendingRestore = null;

  window.__bfIAP = {
    result(r) {
      if (!r || !r.cmd) return;
      if (r.cmd === "status") {
        if (r.price) PRICE = r.price;
        if (r.owned) markOwned();
        const pb = document.getElementById("bf-buy-btn");
        if (pb) pb.textContent = "Unlock forever — " + PRICE;
      } else if (r.cmd === "buy" && pendingBuy) {
        pendingBuy(r); pendingBuy = null;
      } else if (r.cmd === "restore" && pendingRestore) {
        pendingRestore(r); pendingRestore = null;
      }
    }
  };

  function markOwned() {
    kvSet("bf_owned", "1");
    const gate = document.getElementById("unlock-gate");
    if (gate) gate.remove();
  }
  const isOwned = () => kvGet("bf_owned") === "1";

  function daysUsed() {
    let ts = Number(kvGet("first_launch_ts") || 0);
    if (!ts) { ts = Date.now(); kvSet("first_launch_ts", String(ts)); }
    return Math.floor((Date.now() - ts) / 86400e3);
  }

  // Parental gate: multiplication an adult solves instantly, a K-4 kid can't.
  const GATE_QS = [
    ["What is 7 × 8 + 6?", 62], ["What is 9 × 6 + 7?", 61],
    ["What is 8 × 6 + 9?", 57], ["What is 7 × 9 + 8?", 71],
  ];

  function buildGate() {
    if (document.getElementById("unlock-gate")) return;
    const g = document.createElement("div");
    g.id = "unlock-gate";
    g.innerHTML = `
      <div class="ug-card" id="ug-kid">
        <div class="ug-emoji">🌳✨</div>
        <h2>Your free adventure is complete!</h2>
        <p>You explored Brainforest free for ${TRIAL_DAYS} days.<br>It's only <b>${PRICE}</b> to keep it going <b>forever</b> — ask a grown-up!</p>
        <button class="ug-main" id="ug-grownup">I'm a grown-up</button>
      </div>
      <div class="ug-card hidden" id="ug-gate">
        <h2>Grown-ups only</h2>
        <p id="ug-q"></p>
        <input id="ug-answer" type="number" inputmode="numeric" autocomplete="off">
        <button class="ug-main" id="ug-check">Continue</button>
        <button class="ug-link" id="ug-back1">back</button>
      </div>
      <div class="ug-card ug-buy-card hidden" id="ug-buy">
        <img class="ug-key-img" src="img/paywall-key.jpg" alt="">
        <h2 class="ug-buy-title">Brainforest Forever</h2>
        <p class="ug-buy-sub">It's only <b>${PRICE}</b> to keep it going <b>forever</b>.<br>One time. No subscription. No ads. Ever.</p>
        <ul class="ug-features">
          <li><span>📚</span><div><b>2,000+ lessons, K–4th grade</b>Math, reading, science &amp; more</div></li>
          <li><span>👧👦</span><div><b>Every kid in your family</b>Their own progress &amp; stickers</div></li>
          <li><span>✈️</span><div><b>Works 100% offline</b>Airplanes, road trips, anywhere</div></li>
          <li><span>🔒</span><div><b>No ads. No subscription. No tracking.</b>One price, done forever</div></li>
        </ul>
        <button class="ug-main" id="bf-buy-btn">Unlock forever — ${PRICE}</button>
        <button class="ug-link" id="ug-restore">Restore Purchases</button>
        <p class="ug-note hidden" id="ug-msg"></p>
        <p class="ug-fine">One-time purchase. No recurring charges, ever.</p>
      </div>`;
    document.body.appendChild(g);

    const show = (id) => {
      ["ug-kid", "ug-gate", "ug-buy"].forEach(x =>
        document.getElementById(x).classList.toggle("hidden", x !== id));
    };
    let expected = null;
    // debug: jump straight to a card for screenshots (BF_GATE_STEP=gate|buy)
    if (window.__BF_GATE_STEP === "gate") {
      const [q, a] = GATE_QS[0]; expected = a;
      document.getElementById("ug-q").textContent = q;
      show("ug-gate");
    } else if (window.__BF_GATE_STEP === "buy") {
      show("ug-buy"); send("status");
    }
    document.getElementById("ug-grownup").addEventListener("click", () => {
      const [q, a] = GATE_QS[Math.floor(Math.random() * GATE_QS.length)];
      expected = a;
      document.getElementById("ug-q").textContent = q;
      document.getElementById("ug-answer").value = "";
      show("ug-gate");
    });
    document.getElementById("ug-back1").addEventListener("click", () => show("ug-kid"));
    document.getElementById("ug-check").addEventListener("click", () => {
      if (Number(document.getElementById("ug-answer").value) === expected) {
        show("ug-buy");
        send("status");            // refresh live price on the buy button
      } else {
        show("ug-kid");
      }
    });
    const msg = (t) => {
      const m = document.getElementById("ug-msg");
      m.textContent = t; m.classList.remove("hidden");
    };
    document.getElementById("bf-buy-btn").addEventListener("click", () => {
      msg("Opening App Store…");
      pendingBuy = (r) => {
        if (r.ok) { markOwned(); if (window.SFX) SFX.play("fanfare"); }
        else if (r.error === "cancelled") msg("No problem — nothing was charged.");
        else if (r.error === "pending") msg("Waiting on a grown-up to approve this purchase.");
        else msg("Purchase didn't go through. Try again in a moment."
                 + (r.detail ? " (" + r.detail + ")" : r.error ? " (" + r.error + ")" : ""));
      };
      send("buy");
    });
    document.getElementById("ug-restore").addEventListener("click", () => {
      msg("Checking previous purchases…");
      pendingRestore = (r) => {
        if (r.owned) markOwned();
        else msg("No previous purchase found on this Apple account.");
      };
      send("restore");
    });
  }

  function checkGate() {
    const expired = window.__BF_TRIAL_EXPIRED || daysUsed() >= TRIAL_DAYS;
    if (isOwned() || !expired) return;
    buildGate();
  }

  window.addEventListener("load", () => {
    daysUsed();          // stamp first launch no matter what
    send("status");      // learn price + true ownership from StoreKit
    if (!window.__BF_UITOUR || window.__BF_TRIAL_EXPIRED) checkGate();
  });
})();
