// Parameter sweep for the MCTS player, measured as centipawn loss against Stockfish.
//
// All variants see the same positions and the same oracle scores, so differences
// between variants are differences in the search, not in the sample. Results are
// written as JSON for later analysis (and for handing to a reviewer).
//
//   node scripts/sweep.mjs [--positions 20] [--depth 12] [--seed 1] [--out sweep.json]
//                          [--variants '<json array of MCTS option objects>']
//
// Default variants: the current configuration plus the most plausible alternatives.

import fs from "node:fs";
import { Chess } from "chess.js";
import { pickMove } from "../jev-player.js";
import { MCTS } from "../mcts.js";
import { createEngine } from "../stockfish-uci.js";

const flag = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };
const N = Number(flag("positions", 20)), DEPTH = Number(flag("depth", 12)), SEED = Number(flag("seed", 1));
const OUT = flag("out", "sweep.json");
const VARIANTS = JSON.parse(flag("variants", JSON.stringify([
  { name: "base w0.5 s16", simulations: 16, tacticalWeight: 0.5 },
  { name: "w0.25 s16", simulations: 16, tacticalWeight: 0.25 },
  { name: "w0.5 s16 visits", simulations: 16, tacticalWeight: 0.5, selection: "visits" },
  { name: "w0.5 s32", simulations: 32, tacticalWeight: 0.5 },
])));

const engine = await createEngine();
const clamp = (cp) => Math.max(-2000, Math.min(2000, cp));

// Deterministic positions: seeded random opening plies, then Stockfish depth-1 self-play.
async function positions() {
  const out = [];
  let seed = SEED;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  while (out.length < N) {
    const c = new Chess();
    for (let i = 0; i < 6 && !c.isGameOver(); i++) { const ms = c.moves(); c.move(ms[Math.floor(rnd() * ms.length)]); }
    while (!c.isGameOver() && c.history().length < 80 && out.length < N) {
      const r = await engine.bestMove(c, { depth: 1 });
      c.move(r.san);
      const ply = c.history().length;
      if (ply >= 10 && ply % 8 === 2) out.push(new Chess(c.fen()));
    }
  }
  return out;
}

const list = await positions();
console.log(`${list.length} positions, oracle depth ${DEPTH}, ${VARIANTS.length} variants + fast baseline\n`);

const results = { positions: [], variants: { fast: { losses: [] } } };
for (const v of VARIANTS) results.variants[v.name] = { opts: v, losses: [] };

for (const [i, chess] of list.entries()) {
  const scores = await engine.scoreMoves(chess, { depth: DEPTH });
  const top = Math.max(...Object.values(scores));
  const bestSan = Object.keys(scores).find((k) => scores[k] === top);
  const loss = (san) => clamp(top) - clamp(scores[san]);
  const row = { n: i + 1, fen: chess.fen(), stockfish: bestSan, moves: {} };

  const fast = await pickMove(chess);
  row.moves.fast = { san: fast.san, loss: loss(fast.san) };
  results.variants.fast.losses.push(row.moves.fast.loss);

  for (const v of VARIANTS) {
    const { name, ...opts } = v;
    const r = await new MCTS({ concurrency: 6, ...opts }).search(chess);
    row.moves[name] = { san: r.san, loss: loss(r.san), q: r.q, visits: r.visits, priorBest: r.priorBest, tokens: r.usage.input_tokens + r.usage.output_tokens,
      candidates: r.candidates.map((c) => ({ ...c, loss: loss(c.san) })) };
    results.variants[name].losses.push(row.moves[name].loss);
  }
  results.positions.push(row);
  console.log(`#${String(i + 1).padStart(2)}  SF ${bestSan.padEnd(6)} ` + Object.entries(row.moves).map(([k, m]) => `${k}: ${m.san.padEnd(6)} −${String(m.loss).padStart(4)}`).join("   "));
}

console.log();
const summary = {};
for (const [name, v] of Object.entries(results.variants)) {
  const l = v.losses, n = l.length;
  summary[name] = { avgLoss: +(l.reduce((a, b) => a + b, 0) / n).toFixed(1), median: [...l].sort((a, b) => a - b)[Math.floor(n / 2)], best: l.filter((x) => x === 0).length, blunders: l.filter((x) => x >= 100).length };
}
console.table(summary);
results.summary = summary;
results.meta = { positions: N, depth: DEPTH, seed: SEED, date: new Date().toISOString() };
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`written ${OUT}`);
engine.quit();
