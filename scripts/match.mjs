// Benchmark games with alternating colours.
//
//   node scripts/match.mjs [simulations=16] [concurrency=6] [games=2] [--player mcts|fast]
//                          [--vs fast|stockfish] [--elo 1400] [--depth 6] [--max-plies 120]
//
// Default: Jev MCTS vs Jev fast (single call). With --vs stockfish the opponent is the
// Stockfish WASM engine limited to the given Elo (UCI_LimitStrength) searching to --depth.

import { Chess } from "chess.js";
import { pickMove } from "../jev-player.js";
import { MCTS } from "../mcts.js";
import { createEngine } from "../stockfish-uci.js";

const pos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };

const SIMS = Number(pos[0] ?? 16), CONC = Number(pos[1] ?? 6), GAMES = Number(pos[2] ?? 2);
const PLAYER = flag("player", "mcts");
const VS = flag("vs", "fast");
const ELO = Number(flag("elo", 1400));
const DEPTH = Number(flag("depth", 6));
const MAX_PLIES = Number(flag("max-plies", 120));

const engine = VS === "stockfish" ? await createEngine({ elo: ELO }) : null;
const totals = { A: { tok: 0, ms: 0, moves: 0 }, B: { tok: 0, ms: 0, moves: 0 } };
let changed = 0, mctsMoves = 0;
const nameA = PLAYER === "mcts" ? `Jev MCTS(${SIMS})` : "Jev fast";
const nameB = VS === "stockfish" ? `Stockfish Elo ${ELO} d${DEPTH}` : "Jev fast";

async function moveA(chess, searcher) {
  if (PLAYER === "mcts") {
    const r = await searcher.search(chess);
    mctsMoves++; if (r.changedBySearch) changed++;
    return { san: r.san, tok: r.usage.input_tokens + r.usage.output_tokens };
  }
  const p = await pickMove(chess);
  return { san: p.san, tok: p.usage.input_tokens + p.usage.output_tokens };
}
async function moveB(chess) {
  if (engine) { const r = await engine.bestMove(chess, { depth: DEPTH }); return { san: r.san, tok: 0 }; }
  const p = await pickMove(chess);
  return { san: p.san, tok: p.usage.input_tokens + p.usage.output_tokens };
}

async function game(colorA) {
  const chess = new Chess();
  const searcher = new MCTS({ simulations: SIMS, concurrency: CONC });
  while (!chess.isGameOver() && chess.history().length < MAX_PLIES) {
    const t = Date.now();
    const isA = chess.turn() === colorA;
    const { san, tok } = isA ? await moveA(chess, searcher) : await moveB(chess);
    chess.move(san);
    const s = totals[isA ? "A" : "B"];
    s.tok += tok; s.ms += Date.now() - t; s.moves++;
  }
  let result = "draw (ply cap)";
  if (chess.isCheckmate()) result = chess.turn() === colorA ? "B wins" : "A wins";
  else if (chess.isGameOver()) result = "draw";
  console.log(`${nameA} as ${colorA === "w" ? "White" : "Black"}: ${result} after ${chess.history().length} plies`);
  console.log("  " + chess.pgn().replace(/\[.*?\]\s*/g, "").trim());
  return result;
}

const results = [];
for (let g = 0; g < GAMES; g++) results.push(await game(g % 2 === 0 ? "w" : "b"));
const score = results.filter((r) => r === "A wins").length + 0.5 * results.filter((r) => r.startsWith("draw")).length;
console.log(`\nA = ${nameA}, B = ${nameB}`);
console.log(`Results: ${results.join(" | ")}  →  A scores ${score}/${GAMES}`);
for (const [k, s] of Object.entries(totals)) if (s.moves)
  console.log(`${k}: ${s.moves} moves, avg ${(s.ms / s.moves / 1000).toFixed(2)} s, avg ${Math.round(s.tok / s.moves)} tokens/move, total ${s.tok}`);
if (mctsMoves) console.log(`Search overruled the prior in ${changed}/${mctsMoves} MCTS moves`);
engine?.quit();
