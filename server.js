// Small Express server: keeps one game in memory, lets Jev make the next
// move on request and serves the static UI.
// The TypeSafe key stays server-side (TYPESAFE_API_KEY in the environment).

import express from "express";
import { Chess } from "chess.js";
import { pickMove, PLAYERS } from "./jev-player.js";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set.");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

let chess = new Chess();
let log = []; // one entry per played move, including Jev's answers
let totalUsage = { input_tokens: 0, output_tokens: 0 };
let busy = false;

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

app.get("/api/state", (_req, res) => res.json(snapshot()));

app.post("/api/new", (_req, res) => {
  chess = new Chess();
  log = [];
  totalUsage = { input_tokens: 0, output_tokens: 0 };
  res.json(snapshot());
});

app.post("/api/step", async (_req, res) => {
  if (busy) return res.status(409).json({ error: "Jev is still thinking." });
  if (chess.isGameOver()) return res.json(snapshot());
  busy = true;
  const color = chess.turn();
  const started = Date.now();
  try {
    const pick = await pickMove(chess);
    const move = chess.move(pick.san);
    totalUsage.input_tokens += pick.usage.input_tokens;
    totalUsage.output_tokens += pick.usage.output_tokens;
    const top = Object.entries(pick.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([san, p]) => ({ san, p }));
    log.push({
      ply: log.length + 1,
      color,
      player: PLAYERS[color].name,
      san: move.san,
      from: move.from,
      to: move.to,
      confidence: pick.confidence,
      top,
      evaluation: pick.evaluation,
      evaluationLabel: pick.evaluationLegend[String(Math.round(pick.evaluation))],
      tactical: pick.tactical,
      ms: Date.now() - started,
      usage: pick.usage,
      model: pick.model,
    });
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
