/* Brainforest UI tour + layout auditor — DEBUG ONLY (BF_UITOUR env).
   Walks every screen state AND measures the layout at each step:
   - nothing off-screen, nothing under the camera/notch
   - no two tappable controls overlapping
   - no text clipped inside its control
   Findings are persisted via BF.kv so the harness can read them from the
   app container after the run. */
(function () {
  if (!window.__BF_UITOUR) return;
  const STEP_MS = 2500;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const cls = (el, c, on) => el && el.classList[on ? "add" : "remove"](c);

  // expose safe-area insets to JS
  const st = document.createElement("style");
  st.textContent = ":root{--bf-sat:env(safe-area-inset-top);--bf-sal:env(safe-area-inset-left);--bf-sar:env(safe-area-inset-right);}";
  document.head.appendChild(st);
  const inset = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;

  const badge = document.createElement("div");
  badge.style.cssText = "position:fixed;bottom:4px;right:6px;z-index:99999;background:#000c;color:#0f0;" +
    "font:700 11px monospace;padding:3px 8px;border-radius:6px;pointer-events:none;";
  const step = (name) => { badge.textContent = "TOUR:" + name; document.title = name; };

  const AUDIT = { issues: [], steps: [], vw: innerWidth, vh: innerHeight };
  const TAPPABLE = "button, .option-btn, .voice-toggle, .kid-card, .theme-card, .path-island, .grade-btn";
  const TEXTY = ".option-label, .island-name, .kid-name, .big-title, .title-big, .prompt-line, .said";

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return null;
    return r;
  }
  function overlapArea(a, b) {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 0 && y > 0 ? x * y : 0;
  }
  const idOf = (el) => (el.id ? "#" + el.id : el.className && typeof el.className === "string"
    ? "." + el.className.split(" ")[0] : el.tagName) + (el.textContent ? `(${el.textContent.trim().slice(0, 18)})` : "");

  // Which ancestor clips the LAST answer button? (bottom-row cut-off hunt)
  function clipChain(name) {
    const btns = document.querySelectorAll("#lesson .option-btn, #lesson .options button");
    if (!btns.length) return;
    const b = btns[btns.length - 1];
    const chain = [];
    let el = b;
    while (el && el.tagName !== "BODY") {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      chain.push({
        el: (el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]),
        top: Math.round(r.top), bot: Math.round(r.bottom), h: Math.round(r.height),
        ov: cs.overflowY, flex: cs.flex, sh: el.scrollHeight, ch: el.clientHeight
      });
      el = el.parentElement;
    }
    (AUDIT.clips = AUDIT.clips || {})[name] = chain;
  }

  function auditStep(name) {
    AUDIT.steps.push(name);
    clipChain(name);
    const W = innerWidth, H = innerHeight;
    // HUD pills must be fully on-screen — Matt kept catching clipped strips
    document.querySelectorAll(".hud > *").forEach(el => {
      const r = visible(el);
      if (r && (r.left < -1 || r.right > W + 1)) {
        AUDIT.issues.push({ step: name, kind: "hud-offscreen",
          detail: `${idOf(el)} left=${Math.round(r.left)} right=${Math.round(r.right)} vw=${W}` });
      }
    });
    const sat = inset("--bf-sat"), sal = inset("--bf-sal"), sar = inset("--bf-sar");
    const iss = (kind, detail) => AUDIT.issues.push({ step: name, kind, detail });

    // When a modal is open it occludes everything else — audit only inside it.
    const openModal = Array.from(document.querySelectorAll(".modal")).find(m => !m.classList.contains("hidden"));
    const scope = openModal || document;
    // Scrollable screens: content beyond the fold is normal, not "offscreen".
    const activeScreen = document.querySelector(".screen.active");
    const stage = activeScreen && activeScreen.querySelector(".stage");
    const scrollable = (activeScreen && activeScreen.scrollHeight > activeScreen.clientHeight + 20)
      || (stage && stage.scrollHeight > stage.clientHeight + 20);

    const taps = [];
    scope.querySelectorAll(TAPPABLE).forEach(el => {
      if (el === badge) return;
      const r = visible(el); if (!r) return;
      const fixed = getComputedStyle(el).position === "fixed";
      taps.push([el, r]);
      const offEdges = r.left < -2 || r.right > W + 2 || r.top < -2 || r.bottom > H + 2;
      if (offEdges && (!scrollable || fixed)) {
        iss("offscreen", `${idOf(el)} rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} vp=${W}x${H}`);
      }
      // A PARTIALLY cut button at the screen edge looks broken even when the
      // screen scrolls (Matt's rule). Fully below/above the fold is fine.
      const partiallyCutBottom = r.top < H - 8 && r.bottom > H + 4;
      const partiallyCutTop = r.bottom > 8 && r.top < -4;
      // Path islands fade out at the scroll fold by design (scroll-fade hint);
      // artificial mid-scroll audit positions are also exempt.
      const fadeExempt = el.classList.contains("path-island") || window.__bfSkipEdgeCut;
      if (scrollable && !fixed && !fadeExempt && (partiallyCutBottom || partiallyCutTop)) {
        iss("edge-cut", `${idOf(el)} top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} vp=${H}`);
      }
      if (sat > 8 && r.top < sat - 4 && r.height < H * 0.5 && (!scrollable || fixed)) {
        iss("under-notch", `${idOf(el)} top=${Math.round(r.top)} < inset=${Math.round(sat)}`);
      }
      if (r.left < sal - 2 || r.right > W - sar + 2) {
        iss("in-side-inset", `${idOf(el)} l=${Math.round(r.left)} r=${Math.round(r.right)} sal=${sal} sar=${sar}`);
      }
    });
    // pairwise overlap of tappables (ignore parent/child; on scrollable screens
    // content legitimately passes under fixed pills — solid-bg floating controls)
    for (let i = 0; i < taps.length; i++) {
      for (let j = i + 1; j < taps.length; j++) {
        const [ea, ra] = taps[i], [eb, rb] = taps[j];
        if (ea.contains(eb) || eb.contains(ea)) continue;
        const fa = getComputedStyle(ea).position === "fixed";
        const fb = getComputedStyle(eb).position === "fixed";
        if (scrollable && (fa !== fb)) continue;   // accepted: scroll-under-pill
        const area = overlapArea(ra, rb);
        if (area > 100) iss("overlap", `${idOf(ea)} × ${idOf(eb)} area=${Math.round(area)}px²`);
      }
    }
    // Lesson-specific: the actions bar must never cover answers or the
    // read-to-me pill (this was the auditor's blind spot on short screens)
    const actionsBar = document.querySelector("#lesson .actions");
    if (actionsBar && activeScreen && activeScreen.id === "lesson") {
      const ra = actionsBar.getBoundingClientRect();
      document.querySelectorAll("#lesson .option-btn, #lesson .hear-btn, #lesson .bubble, #lesson .title-big").forEach(el => {
        const r = visible(el); if (!r) return;
        if (overlapArea(ra, r) > 60) {
          const stg = document.querySelector("#lesson .stage");
          const sc = getComputedStyle(stg), lc = getComputedStyle(document.querySelector("#lesson"));
          iss("under-actions-bar", `${idOf(el)} over bar ${Math.round(overlapArea(ra, r))}px² | ` +
            `stage ${stg.scrollHeight}/${stg.clientHeight} oy=${sc.overflowY} minh=${sc.minHeight} | ` +
            `lesson disp=${lc.display} rows=${lc.gridTemplateRows} | bar=${Math.round(ra.top)}-${Math.round(ra.bottom)} el=${Math.round(r.top)}-${Math.round(r.bottom)}`);
        }
      });
      // the bubble must never cover the question title/paragraph
      const bub = document.querySelector("#lesson .bubble");
      const tt = document.querySelector("#lesson .title-big");
      if (bub && tt) {
        const rb = visible(bub), rt = visible(tt);
        if (rb && rt && overlapArea(rb, rt) > 60) {
          const st = document.querySelector("#lesson .stage");
          const cs = (el) => { const c = getComputedStyle(el); return `${c.position}/${c.marginTop}/${c.transform.slice(0, 24)}`; };
          iss("bubble-over-title",
            `overlap=${Math.round(overlapArea(rb, rt))}px² bubble=${Math.round(rb.top)}-${Math.round(rb.bottom)}[${cs(bub)}] ` +
            `title=${Math.round(rt.top)}-${Math.round(rt.bottom)}[${cs(tt)}] scrollTop=${st ? st.scrollTop : "?"} ` +
            `stage=${st ? st.scrollHeight + "/" + st.clientHeight : "?"}`);
        }
      }
    }

    // overlay cards / frames: must sit fully inside the screen, borders intact
    scope.querySelectorAll(".finale-card, .modal-card, .fact-toast, .bubble").forEach(el => {
      const r = visible(el); if (!r) return;
      if (r.left < -1 || r.right > W + 1 || r.top < -1 || r.bottom > H + 1) {
        iss("frame-cut", `${idOf(el)} rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} vp=${W}x${H}`);
      }
    });

    // headline/title collisions with controls (title under back pill etc.)
    scope.querySelectorAll(".big-title").forEach(t => {
      const rt = visible(t); if (!rt) return;
      if (rt.bottom < 0 || rt.top > H) return;   // scrolled away — fine
      taps.forEach(([el, r]) => {
        if (t.contains(el) || el.contains(t)) return;
        if (overlapArea(rt, r) > 150) iss("title-overlap", `${idOf(t)} × ${idOf(el)}`);
      });
      if (sat > 8 && rt.top < sat - 4 && !scrollable) iss("title-under-notch", `${idOf(t)} top=${Math.round(rt.top)}`);
    });
    // clipped text
    document.querySelectorAll(TEXTY).forEach(el => {
      const r = visible(el); if (!r) return;
      if (el.scrollWidth > el.clientWidth + 6 || el.scrollHeight > el.clientHeight + 8) {
        iss("text-clip", `${idOf(el)} scroll=${el.scrollWidth}x${el.scrollHeight} client=${el.clientWidth}x${el.clientHeight}`);
      }
    });

    // WCAG contrast: text color vs nearest SOLID background (image/gradient
    // backdrops are skipped — those rely on text shadows, judged by eye).
    const lum = (rgb) => {
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const parseC = (c) => {
      const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    const solidBg = (el) => {
      let n = el;
      while (n && n.nodeType === 1) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage !== "none") return null;
        const c = parseC(cs.backgroundColor);
        if (c && c.a > 0.7) return c.rgb;
        n = n.parentElement;
      }
      return null;
    };
    scope.querySelectorAll(TEXTY + ", .option-label, .kid-grade, .stat .num, .stat .lbl, .book-count, .finale-treasure-name, .finale-sub").forEach(el => {
      const r = visible(el); if (!r) return;
      if (r.bottom < 0 || r.top > H) return;
      const cs = getComputedStyle(el);
      const fg = parseC(cs.color); if (!fg) return;
      const bg = solidBg(el); if (!bg) return;
      const L1 = lum(fg.rgb), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const min = parseFloat(cs.fontSize) >= 24 ? 3 : 4.5;
      if (ratio < min) iss("low-contrast", `${idOf(el)} ratio=${ratio.toFixed(2)}<${min} fg=${fg.rgb} bg=${bg}`);
    });
  }

  async function hold(name) {
    step(name);
    await sleep(STEP_MS - 600);   // let entrance animations finish
    auditStep(name);
    await sleep(600);
  }

  const P = (say, screen, expects) => ({ say, screen, expects: expects || "tap", skill: "math_add", difficulty: 2 });
  const PAYLOADS = [
    ["math-add", P("What is 3 plus 4? Tap the answer!", { type: "math", title: "3 + 4 = ?", prompt: "Tap the answer!", items: ["6", "7", "8", "9"], answer: "7", theme: "space" })],
    // Matt's real-world overflow case: 19 emoji forced the whole grid past the screen edges.
    // Before this one runs, the tour also stuffs the HUD (8 stickers) — his other real cut-off.
    ["math-sub-big", P("What is 19 minus 6?", { type: "math", title: "19 − 6 = ?", prompt: "Tap the answer!", items: ["11", "12", "13", "14"], answer: "13", theme: "mermaid", skill: "math_sub" })],
    ["clock", P("Look at the clock. What time is it?", { type: "math", title: "What time is it?", prompt: "Tap the right time!", clock: { h: 3, m: 30 }, items: ["3:30", "6:15", "3:00", "4:30"], answer: "3:30", theme: "space" })],
    ["coins", P("Count the coins! How many cents is this?", { type: "math", title: "How much money?", prompt: "Count the coins!", coins: [["quarter", 1], ["dime", 2], ["penny", 1]], items: ["46¢", "51¢", "41¢", "56¢"], answer: "46¢", theme: "space" })],
    ["fractions", P("Which fraction is bigger?", { type: "math", title: "Which is bigger?", prompt: "Tap the bigger fraction!", fractions: [[1, 2], [1, 4]], items: ["1/2", "1/4"], answer: "1/2", theme: "space" })],
    ["shape", P("What shape is this?", { type: "word", title: "What shape is this?", prompt: "Tap the shape's name!", shape: "star", items: ["circle", "square", "star", "heart"], answer: "star", theme: "space" })],
    ["sight-word", P('Tap the word that says "because".', { type: "word", title: "BECAUSE", prompt: "Tap the matching word!", items: ["because", "before", "between", "beautiful"], answer: "because", theme: "space" })],
    ["reading-long", P("Read it and pick the best answer.", { type: "reading_comp", title: "The Nile is the longest river in the world. It flows north through Africa for over 4,000 miles. Ancient Egyptians built their civilization along its banks.", prompt: "Why was the Nile important to the Egyptians?", items: ["They built their civilization along it.", "It is in South America.", "It flows south toward the mountains.", "It is a small stream."], answer: "They built their civilization along it.", theme: "space" })],
    ["count-emoji", P("Count them and tap the right number!", { type: "image_word", title: "🚀 🚀 🚀 🚀 🚀 🚀", prompt: "How many?", items: ["5", "6", "7", "8"], answer: "6", theme: "space" })],
    ["trace", { say: "Trace the letter B with your finger!", screen: { type: "trace", title: "", prompt: "Trace the B!", answer: "B", theme: "space" }, expects: "trace", skill: "writing_letter", difficulty: 1 }],
  ];

  async function run() {
    if (!window.__BF_NOBADGE) document.body.appendChild(badge);
    await sleep(1200);
    await hold("picker");

    const addCard = document.querySelector(".add-kid-card");
    if (addCard) {
      addCard.click();
      await sleep(300);
      $("addkid-name").value = "Tess";
      const g2btn = document.querySelector('#addkid-grades [data-grade="2"]');
      if (g2btn) g2btn.click();
      await hold("addkid-modal");
      $("addkid-save").click();
      await sleep(800);
    }
    await hold("welcome");

    STATE.voiceOn = false;
    STATE.theme = "space";
    document.body.className = "theme-space";
    cls($("welcome"), "active", false);
    cls($("kid-picker"), "active", false);
    cls($("lesson"), "active", true);
    setBackdrop("space");
    STATE.questSteps = 9; STATE.questStep = 3;
    renderQuestTrail();
    // worst-case HUD: a full sticker strip (what a real kid earns in a session)
    try { ["👩‍🚀","🚀","☄️","🌟","☄️","🪐","🚀","🌙"].forEach(e => addSticker(e)); } catch (_) {}
    for (const [name, payload] of PAYLOADS) {
      STATE.current = payload;
      STATE.grading = false;
      renderActivity(JSON.parse(JSON.stringify(payload)));
      await hold(name);
    }

    bigCelebrate();
    await hold("celebrate");

    const fin = $("finale");
    $("finale-treasure").textContent = "🗝️";
    $("finale-treasure-name").textContent = "Golden Key";
    $("finale-sub").textContent = "Your first treasure! It's in your sticker book.";
    cls(fin, "hidden", false); cls(fin, "show", true);
    await hold("finale");
    cls(fin, "show", false); cls(fin, "hidden", true);

    cls($("lesson"), "active", false);
    cls($("welcome"), "active", true);
    openPath();
    await sleep(400);
    await hold("path");
    // scroll the path to its bottom — the voice toggle must not hide islands
    const pathEl = $("path");
    pathEl.scrollTop = pathEl.scrollHeight;
    window.__bfSkipEdgeCut = true;      // artificial scroll position
    await hold("path-bottom");
    window.__bfSkipEdgeCut = false;
    cls($("path"), "active", false);
    cls($("welcome"), "active", true);
    openStickerBook();
    await sleep(400);
    await hold("book");

    // persist the audit report, then finish on the parent dashboard
    step("saving-report");
    BF.kv.set("uitour_report", JSON.stringify(AUDIT));
    await sleep(1200);
    step("parent");
    location.href = "parent.html";
  }
  window.addEventListener("load", () => { run().catch(e => { step("ERR"); try { BF.kv.set("uitour_report", JSON.stringify({ fatal: String(e), ...AUDIT })); } catch (_) {} }); });
})();
