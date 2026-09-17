/* Brainforest device-speed tuner.
   Decides whether this phone gets the full effects ("full") or a trimmed set
   ("lite") so gameplay stays snappy on slower hardware. Nothing about the
   learning content changes — only blur, glow, shadows and the decorative
   animation load.

   How it decides, in order:
     1. Last launch's verdict (persisted) — applied before first paint so a slow
        phone never flashes the heavy version.
     2. Hardware hints: few cores / little memory / reduced-motion preference.
     3. A ~700 ms frame-rate sample during the first screen's animations.
     4. A background watchdog for the rest of the session: if frames start
        dropping while playing, it drops to lite on the spot (never flips back
        mid-session, so nothing flickers).

   Sets <html class="perf-lite"> and exposes window.BF_PERF for app.js
   (confetti reads it to shrink the particle count). Fires "bf-perf" on window
   when the tier changes.  Loads after engine.js so BF.kv is available. */
(function () {
  "use strict";

  var root = document.documentElement;
  var KEY = "bf_perf_tier";
  var tier = null;             // "full" | "lite"
  var locked = false;          // once lite for real reasons, stay lite this session

  function kvGet(k) {
    try { return window.BF && BF.kv ? BF.kv.get(k) : localStorage.getItem(k); } catch (e) { return null; }
  }
  function kvSet(k, v) {
    try { window.BF && BF.kv ? BF.kv.set(k, v) : localStorage.setItem(k, v); } catch (e) {}
  }

  function apply(next, reason, persist) {
    if (next === tier) return;
    tier = next;
    root.classList.toggle("perf-lite", next === "lite");
    root.setAttribute("data-perf", next);
    if (persist) kvSet(KEY, next);
    try { console.info("[bf-perf] " + next + (reason ? " (" + reason + ")" : "")); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent("bf-perf", { detail: { tier: next, reason: reason } })); } catch (e) {}
  }

  // ---- 1. Persisted verdict, before first paint ----
  var saved = kvGet(KEY);
  if (saved === "lite") apply("lite", "remembered from last launch", false);

  // ---- 2. Static hints ----
  var cores = navigator.hardwareConcurrency || 0;      // 0 = unknown
  var mem = navigator.deviceMemory || 0;               // GB, 0 = unknown (iOS never says)
  var reducedMotion = false;
  try { reducedMotion = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}

  var hintLite = reducedMotion || (cores > 0 && cores <= 4) || (mem > 0 && mem <= 3);
  if (hintLite) {
    locked = true;
    apply("lite", reducedMotion ? "reduced motion requested" : ("hardware: " + cores + " cores, " + (mem || "?") + " GB"), true);
  }

  // ---- 3. Frame-rate sample (~700 ms) ----
  // Runs while the first screen's entry animations are playing, which is a
  // fair test: if the phone can't hold ~45 fps drawing the welcome screen, the
  // rest of the game won't be smooth either.
  function sample(ms, done) {
    var frames = 0, longFrames = 0, last = 0, start = 0;
    function tick(t) {
      if (!start) { start = t; last = t; requestAnimationFrame(tick); return; }
      var dt = t - last; last = t;
      frames++;
      if (dt > 34) longFrames++;             // slower than 30 fps for that frame
      if (t - start < ms) requestAnimationFrame(tick);
      else done(frames * 1000 / (t - start), longFrames / Math.max(1, frames));
    }
    requestAnimationFrame(tick);
  }

  function bootBench() {
    if (locked) return;
    // Wait half a second so the first screen's build-out (kid cards, voice
    // list) isn't mistaken for a slow GPU, then watch 800 ms of animation.
    setTimeout(function () { sample(800, function (fps, longRatio) {
      if (fps < 30 || (fps < 45 && longRatio > 0.15)) {
        locked = true;
        apply("lite", "boot sample " + fps.toFixed(0) + " fps, " + (longRatio * 100).toFixed(0) + "% long frames", true);
      } else if (tier !== "full") {
        // Fast phone that was remembered as lite (or unknown) — promote and remember.
        apply("full", "boot sample " + fps.toFixed(0) + " fps", true);
      } else {
        kvSet(KEY, "full");
        try { console.info("[bf-perf] full confirmed (boot sample " + fps.toFixed(0) + " fps)"); } catch (e) {}
      }
    }); }, 500);
  }
  if (!tier) apply("full", "default", false);
  if (document.readyState === "complete" || document.readyState === "interactive") bootBench();
  else document.addEventListener("DOMContentLoaded", bootBench);

  // ---- 4. Session watchdog ----
  // Every 2 s of visible time, look at the last window of frames. Two bad
  // windows in a row (>25 % long frames while frames were actually being
  // requested) means the phone is struggling under real gameplay — go lite
  // and stay there for the session.
  var badWindows = 0;
  function watch() {
    if (locked || tier === "lite") return;
    if (document.hidden) { setTimeout(watch, 2000); return; }
    sample(2000, function (fps, longRatio) {
      if (longRatio > 0.25 && fps < 40) badWindows++; else badWindows = 0;
      if (badWindows >= 2) {
        locked = true;
        apply("lite", "watchdog " + fps.toFixed(0) + " fps, " + (longRatio * 100).toFixed(0) + "% long frames", true);
        return;
      }
      setTimeout(watch, 1500);
    });
  }
  setTimeout(watch, 4000);

  window.BF_PERF = {
    get tier() { return tier; },
    isLite: function () { return tier === "lite"; },
    // Manual override for testing from the console: BF_PERF.force("lite"|"full"|null)
    force: function (t) { locked = !!t; if (t) apply(t, "forced", true); else { kvSet(KEY, ""); apply("full", "override cleared", false); } },
  };
})();
