// Kleiner Express-Server: hält eine Partie im Speicher, lässt auf Anfrage
// Jev den nächsten Zug machen und liefert die statische Oberfläche aus.
// Der TypeSafe-Key bleibt serverseitig (TYPESAFE_API_KEY im Environment).

import express from "express";
import { Chess } from "chess.js";
import { pickMove, PLAYERS } from "./jev-player.js";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY ist nicht gesetzt.");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

let chess = new Chess();
let log = []; // ein Eintrag pro gespieltem Zug, inkl. Jev-Antworten
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
  if (chess.isCheckmate()) return `Schachmatt. ${chess.turn() === "w" ? PLAYERS.b.name : PLAYERS.w.name} gewinnt.`;
  if (chess.isStalemate()) return "Patt. Remis.";
  if (chess.isThreefoldRepetition()) return "Dreifache Stellungswiederholung. Remis.";
  if (chess.isInsufficientMaterial()) return "Ungenügendes Material. Remis.";
  if (chess.isDrawByFiftyMoves?.() || chess.isDraw()) return "Remis (50-Züge-Regel).";
  return "Remis.";
}

app.get("/api/state", (_req, res) => res.json(snapshot()));

app.post("/api/new", (_req, res) => {
  chess = new Chess();
  log = [];
  totalUsage = { input_tokens: 0, output_tokens: 0 };
  res.json(snapshot());
});

app.post("/api/step", async (_req, res) => {
  if (busy) return res.status(409).json({ error: "Jev denkt noch." });
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
app.listen(port, () => console.log(`TypeSafe-Schach läuft auf http://localhost:${port}`));
