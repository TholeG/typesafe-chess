// Mechanics test against a minimax oracle, no API calls.
//
// With a perfect-information evaluator (material after forced captures), a correct
// PUCT search given enough simulations must agree with a shallow minimax on
// tactical positions. Disagreement on many positions = bug in mcts.js.
// The evaluator is injected, so Jev is not involved at all.
//
// Usage: node scripts/mcts-oracle.mjs [positions=30] [simulations=400] [seed=1] [concurrency=8] [oracleDepth=2] [debugIndex]

import { Chess } from "chess.js";
import { MCTS } from "../mcts.js";
import { quiesce } from "../tactics.js";

const N_POS = Number(process.argv[2] ?? 30);
const SIMS = Number(process.argv[3] ?? 400);
let seed = Number(process.argv[4] ?? 1);
const CONC = Number(process.argv[5] ?? 8);
const DEPTH = Number(process.argv[6] ?? 2);
const DEBUG = process.argv[7] ? Number(process.argv[7]) : null;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// Leaf evaluator: settled material from the mover's view, squashed. Uniform policy.
async function evaluate(chess) {
  const moves = chess.moves();
  const value = Math.tanh(quiesce(new Chess(chess.fen())) / 4);
  return { policy: Object.fromEntries(moves.map((m) => [m, 1 / moves.length])), value };
}

// Alpha-beta negamax with quiescence at the horizon, values from the mover's view.
function negamax(chess, depth, alpha, beta) {
  if (chess.isCheckmate()) return -1000;
  if (chess.isDraw()) return 0;
  if (depth === 0) return quiesce(chess, alpha, beta);
  let best = -Infinity;
  const moves = chess.moves({ verbose: true }).sort((x, y) => (y.captured ? 1 : 0) - (x.captured ? 1 : 0));
  for (const m of moves) {
    chess.move(m.san);
    const v = -negamax(chess, depth - 1, -beta, -alpha);
    chess.undo();
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}
function oracle(chess, depth = 2) {
  const scores = {};
  for (const m of chess.moves()) {
    chess.move(m);
    scores[m] = -negamax(chess, depth - 1, -Infinity, Infinity);
    chess.undo();
  }
  const best = Math.max(...Object.values(scores));
  return { scores, best };
}

// Random middlegame positions where the oracle's best move gains at least one pawn
// over the worst move (i.e. something tactical is going on).
function randomTacticalPosition() {
  for (;;) {
    const c = new Chess();
    const plies = 10 + Math.floor(rnd() * 20);
    for (let i = 0; i < plies && !c.isGameOver(); i++) {
      const ms = c.moves();
      c.move(ms[Math.floor(rnd() * ms.length)]);
    }
    if (c.isGameOver()) continue;
    const o = oracle(c, DEPTH);
    const vals = Object.values(o.scores);
    if (o.best - Math.min(...vals) >= 2 && vals.filter((v) => v === o.best).length <= 3) return { chess: c, o };
  }
}

let agree = 0, regret = 0;
const rows = [];
for (let i = 0; i < N_POS; i++) {
  const { chess, o } = randomTacticalPosition();
  const mcts = new MCTS({ simulations: SIMS, concurrency: CONC, evaluate, tacticalWeight: 0 });
  const r = await mcts.search(chess);
  const got = o.scores[r.san];
  if (DEBUG === i + 1) {
    console.log(chess.ascii(), chess.fen());
    const root = mcts.lastRoot;
    const rows = Object.entries(root.edges).map(([san, e]) => ({ san, P: e.P.toFixed(3), N: e.N, Q: e.N ? (e.W / e.N).toFixed(2) : "–",
      childV: e.child?.value?.toFixed(2) ?? (e.child?.terminal ?? "–"), oracle: o.scores[san] }))
      .sort((a, b) => b.N - a.N);
    console.table(rows.slice(0, 12));
  }
  const ok = got === o.best;
  if (ok) agree++; else regret += o.best - got;
  rows.push({ n: i + 1, chosen: r.san, mctsQ: r.q?.toFixed(2), oracleBest: Object.keys(o.scores).find((m) => o.scores[m] === o.best), gotValue: got, bestValue: o.best, ok });
}
console.table(rows);
console.log(`Agreement with depth-${DEPTH} minimax oracle: ${agree}/${N_POS} (${Math.round((agree / N_POS) * 100)} %), total regret ${regret} pawns, ${SIMS} sims each, concurrency ${CONC}`);
process.exit(agree / N_POS >= 0.8 ? 0 : 1);
