// Move-quality measurement against Stockfish.
//
// For a set of middlegame positions, Stockfish scores every legal move (fixed depth,
// deterministic). Then Jev's fast player and Jev's MCTS player each pick a move, and we
// report the centipawn loss against Stockfish's best move. This replaces "did it win
// two games" with a per-move measurement on identical positions.
//
//   node scripts/regret.mjs [positions=10] [simulations=16] [oracleDepth=12] [--seed 1] [--skip-mcts]
//
// Positions come from a Stockfish self-play game at very low depth (weak, tactical, but
// deterministic), sampled between plies 8 and 70.

import { Chess } from "chess.js";
import { pickMove } from "../jev-player.js";
import { MCTS } from "../mcts.js";
import { createEngine, MATE } from "../stockfish-uci.js";

const pos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };
const N = Number(pos[0] ?? 10), SIMS = Number(pos[1] ?? 16), DEPTH = Number(pos[2] ?? 12);
const SEED = Number(flag("seed", 1));
const SKIP_MCTS = process.argv.includes("--skip-mcts");

const engine = await createEngine();
const clamp = (cp) => Math.max(-2000, Math.min(2000, cp)); // cap mates for averaging

// Deterministic position source: self-play at depth 1 + seed-dependent opening plies.
async function positions() {
  const c = new Chess();
  let seed = SEED;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 4 && !c.isGameOver(); i++) { const ms = c.moves(); c.move(ms[Math.floor(rnd() * ms.length)]); }
  const out = [];
  while (!c.isGameOver() && c.history().length < 70) {
    const r = await engine.bestMove(c, { depth: 1 });
    c.move(r.san);
    const ply = c.history().length;
    if (ply >= 8 && ply % 6 === 2) out.push(new Chess(c.fen()));
    if (out.length >= N) break;
  }
  return out;
}

const rows = [];
const sum = { fast: 0, mcts: 0 }, best = { fast: 0, mcts: 0 }, blunders = { fast: 0, mcts: 0 };
const list = await positions();
console.log(`${list.length} positions, oracle depth ${DEPTH}, MCTS ${SIMS} evaluations\n`);
for (const [i, chess] of list.entries()) {
  const scores = await engine.scoreMoves(chess, { depth: DEPTH });
  const top = Math.max(...Object.values(scores));
  const bestSan = Object.keys(scores).find((k) => scores[k] === top);
  const loss = (san) => clamp(top) - clamp(scores[san]);

  const fast = await pickMove(chess);
  const fastLoss = loss(fast.san);
  sum.fast += fastLoss; if (fastLoss === 0) best.fast++; if (fastLoss >= 100) blunders.fast++;

  let mctsSan = "–", mctsLoss = null;
  if (!SKIP_MCTS) {
    const r = await new MCTS({ simulations: SIMS, concurrency: 6 }).search(chess);
    mctsSan = r.san; mctsLoss = loss(r.san);
    sum.mcts += mctsLoss; if (mctsLoss === 0) best.mcts++; if (mctsLoss >= 100) blunders.mcts++;
  }
  rows.push({ n: i + 1, ply: Number(chess.fen().split(" ")[5]) * 2 - (chess.turn() === "w" ? 2 : 1), stockfish: bestSan, fast: fast.san, fastLoss, mcts: mctsSan, mctsLoss });
  console.log(`#${i + 1}  SF ${bestSan.padEnd(6)}  fast ${fast.san.padEnd(6)} −${String(fastLoss).padStart(4)} cp   mcts ${mctsSan.padEnd(6)} ${mctsLoss == null ? "" : "−" + String(mctsLoss).padStart(4) + " cp"}`);
}
console.log();
console.table(rows);
const n = list.length;
console.log(`fast : avg loss ${(sum.fast / n).toFixed(0)} cp, best move ${best.fast}/${n}, blunders (≥100 cp) ${blunders.fast}`);
if (!SKIP_MCTS) console.log(`mcts : avg loss ${(sum.mcts / n).toFixed(0)} cp, best move ${best.mcts}/${n}, blunders (≥100 cp) ${blunders.mcts}`);
engine.quit();
