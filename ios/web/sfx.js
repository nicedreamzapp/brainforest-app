/* Brainforest SFX — synthesized game sounds (WebAudio, zero assets, fully offline).
   window.SFX.play(name): tap | correct | wrong | reveal | sticker | fanfare | finale */

(function () {
  "use strict";
  let ctx = null;
  let muted = false;

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  // One synthesized note: freq (Hz), start offset (s), dur (s), options.
  function note(t0, freq, dur, opts) {
    const a = ac(); if (!a) return;
    opts = opts || {};
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = opts.type || "triangle";
    osc.frequency.setValueAtTime(freq, a.currentTime + t0);
    if (opts.slide) osc.frequency.exponentialRampToValueAtTime(opts.slide, a.currentTime + t0 + dur);
    const vol = (opts.vol || 0.18) * (opts.fade || 1);
    gain.gain.setValueAtTime(0.0001, a.currentTime + t0);
    gain.gain.exponentialRampToValueAtTime(vol, a.currentTime + t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + t0 + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(a.currentTime + t0);
    osc.stop(a.currentTime + t0 + dur + 0.05);
  }

  // Sparkly noise burst (sticker pop / confetti glitter)
  function sparkle(t0, dur, vol) {
    const a = ac(); if (!a) return;
    const n = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, n, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    const src = a.createBufferSource();
    src.buffer = buf;
    const bp = a.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 5200; bp.Q.value = 1.2;
    const g = a.createGain(); g.gain.value = vol || 0.14;
    src.connect(bp).connect(g).connect(a.destination);
    src.start(a.currentTime + t0);
  }

  const SOUNDS = {
    // subtle UI blip
    tap:     () => note(0, 660, 0.07, { type: "sine", vol: 0.08 }),
    // rising major arpeggio — the "you got it!" hit
    correct: () => { note(0, 523, 0.09); note(0.07, 659, 0.09); note(0.14, 784, 0.16, { vol: 0.22 }); sparkle(0.16, 0.18, 0.08); },
    // gentle low boop — never punishing
    wrong:   () => note(0, 220, 0.18, { type: "sine", slide: 180, vol: 0.12 }),
    // soft "here's the answer" chime
    reveal:  () => { note(0, 392, 0.12, { type: "sine", vol: 0.1 }); note(0.12, 523, 0.2, { type: "sine", vol: 0.1 }); },
    // sticker pop
    sticker: () => { note(0, 880, 0.06, { type: "square", vol: 0.07, slide: 1320 }); sparkle(0.03, 0.12, 0.1); },
    // 3-in-a-row streak fanfare
    fanfare: () => {
      [523, 659, 784, 1047].forEach((f, i) => note(i * 0.09, f, 0.14, { vol: 0.2 }));
      note(0.36, 1047, 0.3, { vol: 0.22 }); sparkle(0.4, 0.25, 0.1);
    },
    // quest finale — triumphant little trumpet run
    finale: () => {
      [392, 392, 392, 523].forEach((f, i) => note(i * 0.12, f, 0.11, { type: "sawtooth", vol: 0.12 }));
      [659, 784, 1047].forEach((f, i) => note(0.48 + i * 0.14, f, 0.2, { type: "sawtooth", vol: 0.14 }));
      note(0.9, 1319, 0.5, { type: "sawtooth", vol: 0.16 });
      sparkle(0.95, 0.4, 0.12);
    },
  };

  window.SFX = {
    play(name) {
      if (muted) return;
      const f = SOUNDS[name];
      if (f) { try { f(); } catch (_) {} }
    },
    mute(on) { muted = !!on; },
    prime() { ac(); },   // call inside a user gesture to unlock audio
  };
})();
