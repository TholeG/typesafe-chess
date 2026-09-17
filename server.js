// Small Express server: keeps one game in memory, lets Jev make the next
// move on request and serves the static UI.
// The TypeSafe key stays server-side (TYPESAFE_API_KEY in the environment).

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { pickMove, PLAYERS } from "./jev-player.js";
import { MCTS } from "./mcts.js";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist");
if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error("dist/index.html not found. Run `npm run build` (or `npm start`, which builds first).");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(distDir));

// Search settings. "fast" = one Jev call per move. "mcts" = tree search with
// Jev as policy and value; each expansion is one Jev call (minus cache hits).
const settings = {
  mode: process.env.MODE ?? "mcts",
  simulations: Number(process.env.MCTS_SIMULATIONS ?? 16),
  concurrency: Number(process.env.MCTS_CONCURRENCY ?? 4),
};

let chess = new Chess();
let log = []; // one entry per played move, including Jev's answers
let totalUsage = { input_tokens: 0, output_tokens: 0 };
let busy = false;
let searcher = new MCTS(settings); // its position cache persists for the whole game
let gameVersion = 0; // bumped on every reset so a stale search result is discarded

function snapshot() {
  return {
    fen: chess.fen(),
    turn: chess.turn(),
    players: { w: PLAYERS.w.name, b: PLAYERS.b.name },
    moveNumber: chess.moveNumber(),
    inCheck: chess.inCheck(),
    gameOver: chess.isGameOver(),
    result: resultText(),
    history: chess.history(),
    log,
    totalUsage,
    busy,
    settings,
  };
}

function resultText() {
  if (!chess.isGameOver()) return null;
  if (chess.isCheckmate()) return `Checkmate. ${chess.turn() === "w" ? PLAYERS.b.name : PLAYERS.w.name} wins.`;
  if (chess.isStalemate()) return "Stalemate. Draw.";
  if (chess.isThreefoldRepetition()) return "Threefold repetition. Draw.";
  if (chess.isInsufficientMaterial()) return "Insufficient material. Draw.";
  if (chess.isDrawByFiftyMoves?.() || chess.isDraw()) return "Draw (fifty-move rule).";
  return "Draw.";
}

function newGame() {
  gameVersion++;
  chess = new Chess();
  log = [];
  totalUsage = { input_tokens: 0, output_tokens: 0 };
  searcher = new MCTS(settings);
}

app.get("/api/state", (_req, res) => res.json(snapshot()));

app.post("/api/new", (_req, res) => {
  newGame();
  res.json(snapshot());
});

app.post("/api/settings", (req, res) => {
  const { mode, simulations, concurrency } = req.body ?? {};
  if (mode === "fast" || mode === "mcts") settings.mode = mode;
  if (Number.isInteger(simulations) && simulations >= 1 && simulations <= 200) settings.simulations = simulations;
  if (Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16) settings.concurrency = concurrency;
  searcher.simulations = settings.simulations;
  searcher.concurrency = settings.concurrency;
  res.json(snapshot());
});

app.post("/api/step", async (_req, res) => {
  if (busy) return res.status(409).json({ error: "Jev is still thinking." });
  if (chess.isGameOver()) return res.json(snapshot());
  busy = true;
  const version = gameVersion;
  const game = chess;
  const color = chess.turn();
  const started = Date.now();
  // san -> { from, to } for the position before the move, used to draw candidate arrows
  const squares = Object.fromEntries(chess.moves({ verbose: true }).map((m) => [m.san, { from: m.from, to: m.to }]));
  const withSquares = (cands) => cands.map((c) => ({ ...c, ...squares[c.san] }));
  try {
    let entry;
    if (settings.mode === "mcts") {
      const r = await searcher.search(game);
      if (version !== gameVersion) return res.status(409).json({ error: "Game was reset while thinking.", ...snapshot() });
      const move = chess.move(r.san);
      entry = {
        mode: "mcts",
        san: move.san, from: move.from, to: move.to,
        simulations: r.simulations,
        evaluations: r.evaluations,
        cacheHits: r.cacheHits,
        q: r.q,
        priorBest: r.priorBest,
        changedBySearch: r.changedBySearch,
        reason: r.reason,
        pendingCollisions: r.pendingCollisions,
        candidates: withSquares(r.candidates), // { san, prior, visits, q, from, to }
        confidence: r.rootEval.confidence,
        evaluation: r.rootEval.evaluation,
        evaluationLabel: r.rootEval.evaluationLegend[String(Math.round(r.rootEval.evaluation))],
        tactical: r.rootEval.tactical,
        usage: r.usage,
        model: r.model ?? r.rootEval.model,
      };
    } else {
      const pick = await pickMove(game);
      if (version !== gameVersion) return res.status(409).json({ error: "Game was reset while thinking.", ...snapshot() });
      const move = chess.move(pick.san);
      entry = {
        mode: "fast",
        san: move.san, from: move.from, to: move.to,
        candidates: withSquares(Object.entries(pick.probabilities)
          .sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([san, prior]) => ({ san, prior, visits: null, q: null }))),
        confidence: pick.confidence,
        evaluation: pick.evaluation,
        evaluationLabel: pick.evaluationLegend[String(Math.round(pick.evaluation))],
        tactical: pick.tactical,
        usage: pick.usage,
        model: pick.model,
      };
    }
    totalUsage.input_tokens += entry.usage.input_tokens;
    totalUsage.output_tokens += entry.usage.output_tokens;
    log.push({ ply: log.length + 1, color, player: PLAYERS[color].name, ms: Date.now() - started, fenAfter: chess.fen(), ...entry });
    res.json(snapshot());
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: String(err?.message ?? err), ...snapshot() });
  } finally {
    busy = false;
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`TypeSafe chess is running at http://localhost:${port}`));
