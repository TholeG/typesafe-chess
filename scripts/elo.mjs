// Elo estimate for a Jev player from games against Stockfish at limited strength.
//
//   node scripts/elo.mjs [--player mcts|fast] [--sims 16] [--conc 6] [--games 2]
//                        [--levels 1320,1600,1900,2200] [--depth 6] [--max-plies 160]
//
// For every level, `games` games are played with alternating colours against Stockfish
// (UCI_LimitStrength + UCI_Elo, fixed search depth). The rating is then the maximum-
// likelihood estimate under the Elo model P(win) = 1 / (1 + 10^((opp - R) / 400)),
// with draws counted as half a point, plus a 95 % interval from the likelihood profile.
//
// Caveats, stated plainly: Stockfish's Elo limiter is calibrated for the full engine at
// tournament time controls; with the lite WASM build at a fixed low depth the scale is
// approximate and probably optimistic for the opponent. Each game costs about 40 moves of
// the chosen player; for MCTS that is roughly 2M tokens per game. Expect ±150 Elo or worse
// from 8 games; the interval printed below is the honest width.

import { Chess } from "chess.js";
import { pickMove } from "../jev-player.js";
import { MCTS } from "../mcts.js";
import { createEngine } from "../stockfish-uci.js";

const flag = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };
const PLAYER = flag("player", "mcts");
const SIMS = Number(flag("sims", 16)), CONC = Number(flag("conc", 6));
const GAMES = Number(flag("games", 2));
const LEVELS = String(flag("levels", "1320,1600,1900,2200")).split(",").map(Number);
const DEPTH = Number(flag("depth", 6));
const MAX_PLIES = Number(flag("max-plies", 160));

const engine = await createEngine();
const results = []; // { opp, score }
let tokens = 0, moves = 0, msTotal = 0;

async function playerMove(chess, searcher) {
  const t = Date.now();
  let san;
  if (PLAYER === "mcts") { const r = await searcher.search(chess); san = r.san; tokens += r.usage.input_tokens + r.usage.output_tokens; }
  else { const p = await pickMove(chess); san = p.san; tokens += p.usage.input_tokens + p.usage.output_tokens; }
  moves++; msTotal += Date.now() - t;
  return san;
}

async function game(opp, color) {
  await engine.setStrength({ elo: opp });
  const chess = new Chess();
  const searcher = new MCTS({ simulations: SIMS, concurrency: CONC });
  while (!chess.isGameOver() && chess.history().length < MAX_PLIES) {
    const san = chess.turn() === color ? await playerMove(chess, searcher) : (await engine.bestMove(chess, { depth: DEPTH })).san;
    chess.move(san);
  }
  let score = 0.5, text = "draw";
  if (chess.isCheckmate()) { score = chess.turn() === color ? 0 : 1; text = score ? "WIN" : "loss"; }
  else if (!chess.isGameOver()) text = "draw (ply cap)";
  console.log(`vs Stockfish ${opp} as ${color === "w" ? "White" : "Black"}: ${text} in ${chess.history().length} plies`);
  console.log("  " + chess.pgn().replace(/\[.*?\]\s*/g, "").trim());
  return score;
}

for (const opp of LEVELS) {
  for (let g = 0; g < GAMES; g++) results.push({ opp, score: await game(opp, g % 2 === 0 ? "w" : "b") });
}
engine.quit();

// Maximum likelihood over R
const expected = (R, opp) => 1 / (1 + 10 ** ((opp - R) / 400));
const logLik = (R) => results.reduce((s, r) => { const p = Math.min(1 - 1e-9, Math.max(1e-9, expected(R, r.opp))); return s + r.score * Math.log(p) + (1 - r.score) * Math.log(1 - p); }, 0);
let bestR = 1000, bestL = -Infinity;
for (let R = 400; R <= 3200; R += 1) { const L = logLik(R); if (L > bestL) { bestL = L; bestR = R; } }
const inInterval = (R) => bestL - logLik(R) <= 1.92; // chi-square(1) 95 %
let lo = bestR, hi = bestR;
while (lo > 400 && inInterval(lo - 1)) lo--;
while (hi < 3200 && inInterval(hi + 1)) hi++;
const allWon = results.every((r) => r.score === 1), allLost = results.every((r) => r.score === 0);

console.log(`\nPlayer: ${PLAYER === "mcts" ? `Jev MCTS (${SIMS} evaluations)` : "Jev fast"} · ${results.length} games · ${moves} moves · ${(msTotal / moves / 1000).toFixed(1)} s and ${Math.round(tokens / moves)} tokens per move`);
for (const opp of LEVELS) {
  const rs = results.filter((r) => r.opp === opp);
  console.log(`  vs ${opp}: ${rs.reduce((s, r) => s + r.score, 0)}/${rs.length}`);
}
if (allWon || allLost) console.log(`\nEstimated Elo: ${allWon ? "above" : "below"} the tested range (every game ${allWon ? "won" : "lost"}); extend --levels.`);
else console.log(`\nEstimated Elo: ${bestR}  (95 % interval ${lo === 400 ? "<400" : lo} – ${hi === 3200 ? ">3200" : hi}, ${results.length} games)`);
console.log("Scale caveat: Stockfish lite WASM at fixed depth with UCI_Elo; treat as relative, not FIDE.");
