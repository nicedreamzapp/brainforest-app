// Generates a realistic demo store for App Store screenshots by playing the
// REAL engine in Node (same bootstrap as tests/sim_engine.mjs): one kid,
// several sessions, real mastery/stickers/treasures/quests. Prints the store
// JSON to stdout — write it to the simulator container as
// Documents/brainforest_store.json before a BF_DEMO tour run.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

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
global.fetch = async (path) => {
  try {
    const data = readFileSync(join(ROOT, String(path)));
    return { ok: true, status: 200, json: async () => JSON.parse(data.toString()) };
  } catch (e) { return { ok: false, status: 404, json: async () => { throw e; } }; }
};

eval(readFileSync(join(ROOT, "engine.js"), "utf8"));
const api = (method, path, body) => window.fetch(path, { method, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
await new Promise(r => setTimeout(r, 150)); // let content banks load

await api("POST", "/api/kid/create", { name: "Tess", grade: 2 });

// A believable couple of weeks: strong at add/sub/sight words, growing at
// money/clock, still working on fractions.
const PLAN = [
  ["math_add", 26, 0.92], ["math_sub", 22, 0.88], ["sight_words", 24, 0.94],
  ["money", 14, 0.78], ["clock", 12, 0.72], ["spelling", 16, 0.85],
  ["reading_comp", 10, 0.82], ["fractions", 8, 0.6], ["science", 8, 0.9],
];
const themes = ["mermaids", "space", "unicorns"];
let t = 0;
for (const [skill, n, acc] of PLAN) {
  const theme = themes[t++ % themes.length];
  await api("POST", "/api/session/start", { theme });
  for (let i = 0; i < n; i++) {
    const correct = (i / n) < acc;   // deterministic, no Math.random needed
    await api("POST", "/api/attempt", { skill, correct, difficulty: 1 + (i % 2), theme });
  }
}

// a few finished quests -> treasures + quests_done
for (let q = 0; q < 4; q++) {
  const r = await api("POST", "/api/quest/complete", { theme: themes[q % 3] });
  if (r && r.error) break; // endpoint name differs — treasures may already exist via streaks
}

const col = await api("GET", "/api/collection");
const m = await api("GET", "/api/mastery");
console.error("skills:", m.mastery.length,
  "attempts:", m.mastery.reduce((a, b) => a + b.attempts, 0),
  "stickers:", col.total_stickers ?? "?",
  "treasures:", (col.treasures || []).length,
  "quests:", col.quests_done ?? "?");
// persist() debounces ~500ms — wait for the last save to flush before dumping
await new Promise(r => setTimeout(r, 1500));
process.stdout.write(localStore["brainforest_store"]);
