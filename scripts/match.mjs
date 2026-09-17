import { Chess } from "chess.js";
import { pickMove } from "../jev-player.js";
import { MCTS } from "../mcts.js";

// Usage: node scripts/match.mjs [simulations] [concurrency] [games]
// Plays MCTS vs the fast single-call player with alternating colours and prints results and cost.
const SIMS = Number(process.argv[2] ?? 16), CONC = Number(process.argv[3] ?? 6), GAMES = Number(process.argv[4] ?? 2), MAX_PLIES = 120;
const totals = { mcts: { tok: 0, ms: 0, moves: 0 }, fast: { tok: 0, ms: 0, moves: 0 } };
let changed = 0, mctsMoves = 0;

async function game(mctsColor) {
  const chess = new Chess();
  const searcher = new MCTS({ simulations: SIMS, concurrency: CONC });
  while (!chess.isGameOver() && chess.history().length < MAX_PLIES) {
    const t = Date.now();
    if (chess.turn() === mctsColor) {
      const r = await searcher.search(chess);
      chess.move(r.san);
      totals.mcts.tok += r.usage.input_tokens + r.usage.output_tokens; totals.mcts.ms += Date.now() - t; totals.mcts.moves++;
      mctsMoves++; if (r.changedBySearch) changed++;
    } else {
      const p = await pickMove(chess);
      chess.move(p.san);
      totals.fast.tok += p.usage.input_tokens + p.usage.output_tokens; totals.fast.ms += Date.now() - t; totals.fast.moves++;
    }
  }
  let result = "draw (ply cap)";
  if (chess.isCheckmate()) result = (chess.turn() === mctsColor) ? "FAST wins" : "MCTS wins";
  else if (chess.isGameOver()) result = "draw";
  console.log(`MCTS as ${mctsColor === "w" ? "White" : "Black"}: ${result} after ${chess.history().length} plies`);
  console.log("  " + chess.pgn().replace(/\[.*?\]\s*/g, "").trim());
  return result;
}

const results = [];
for (let g = 0; g < GAMES; g++) results.push(await game(g % 2 === 0 ? "w" : "b"));
console.log("\nResults:", results.join(" | "));
console.log(`MCTS: ${totals.mcts.moves} moves, avg ${(totals.mcts.ms/totals.mcts.moves/1000).toFixed(1)} s, avg ${Math.round(totals.mcts.tok/totals.mcts.moves)} tokens/move, total ${totals.mcts.tok}`);
console.log(`FAST: ${totals.fast.moves} moves, avg ${(totals.fast.ms/totals.fast.moves/1000).toFixed(2)} s, avg ${Math.round(totals.fast.tok/totals.fast.moves)} tokens/move, total ${totals.fast.tok}`);
console.log(`Search overruled the prior in ${changed}/${mctsMoves} MCTS moves`);
