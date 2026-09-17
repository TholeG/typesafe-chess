// Jev als Schachspieler.
//
// Arbeitsteilung nach dem TypeSafe-Modell: chess.js kennt die Regeln und
// erzeugt die legalen Züge (Code). Jev bekommt die Stellung plus eine
// Beschreibung jedes legalen Zugs als Choice-Optionen und wählt einen aus
// (Urteil). Zusätzlich fragen wir im selben Aufruf eine Stellungsbewertung
// (Score) und eine Noul-Frage nach taktischer Schärfe ab. Beide sind nur
// Anzeige-Signale und beeinflussen den Zug nicht.

import { Chess } from "chess.js";
import { TypeSafeClient, choice, score, noul } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ timeout: 20000 });

const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Zwei Spielstile, damit die beiden Jev-Instanzen sich unterscheiden.
export const PLAYERS = {
  w: {
    name: "Jev White",
    style:
      "You play actively. You like open lines, quick development, central control " +
      "and initiative. You take sound tactical chances but never blunder material.",
  },
  b: {
    name: "Jev Black",
    style:
      "You play solidly. You value king safety, pawn structure, piece coordination " +
      "and avoiding weaknesses. You strike back when the opponent overextends.",
  },
};

function materialBalance(chess) {
  let sum = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      sum += (sq.color === "w" ? 1 : -1) * PIECE_VALUES[sq.type];
    }
  }
  return sum; // positiv = Weiß vorn
}

// Kann der Gegner nach diesem Zug die gezogene Figur auf ihrem Zielfeld schlagen?
function attackedAfter(chess, move) {
  const probe = new Chess(chess.fen());
  probe.move(move.san);
  if (probe.isGameOver()) return { attacked: false, defended: false };
  const enemy = probe.moves({ verbose: true }).filter((m) => m.to === move.to && m.captured);
  if (enemy.length === 0) return { attacked: false, defended: false };
  // Verteidigt? Wir prüfen, ob nach dem billigsten gegnerischen Schlag ein Rückschlag existiert.
  const cheapest = enemy.reduce((a, b) => (PIECE_VALUES[a.piece] <= PIECE_VALUES[b.piece] ? a : b));
  const probe2 = new Chess(probe.fen());
  probe2.move(cheapest.san);
  const recapture = probe2.moves({ verbose: true }).some((m) => m.to === move.to && m.captured);
  return { attacked: true, defended: recapture, cheapestAttacker: PIECE_NAMES[cheapest.piece] };
}

function describeMove(chess, move) {
  const d = {
    piece: PIECE_NAMES[move.piece],
    from: move.from,
    to: move.to,
  };
  if (move.captured) d.captures = PIECE_NAMES[move.captured];
  if (move.promotion) d.promotes_to = PIECE_NAMES[move.promotion];
  if (move.isKingsideCastle?.() || move.flags.includes("k")) d.castles = "kingside";
  if (move.isQueensideCastle?.() || move.flags.includes("q")) d.castles = "queenside";
  if (move.san.endsWith("#")) d.result = "checkmate";
  else if (move.san.endsWith("+")) d.gives_check = true;

  const probe = new Chess(chess.fen());
  probe.move(move.san);
  if (!d.result && probe.isDraw()) d.result = "draw";

  const threat = attackedAfter(chess, move);
  if (threat.attacked) {
    d.piece_can_be_captured_on_arrival = threat.defended
      ? `yes, by ${threat.cheapestAttacker}, but the square is defended (exchange possible)`
      : `yes, by ${threat.cheapestAttacker}, and it is NOT defended (hangs the piece)`;
  }
  return d;
}

function buildState(chess, color) {
  const history = chess.history();
  const balance = materialBalance(chess);
  const us = color === "w" ? "white" : "black";
  const ownBalance = color === "w" ? balance : -balance;
  return {
    you_play: us,
    your_style: PLAYERS[color].style,
    board_ascii: chess.ascii(),
    fen: chess.fen(),
    move_number: chess.moveNumber(),
    in_check: chess.inCheck(),
    material_balance_from_your_view:
      ownBalance === 0 ? "equal" : ownBalance > 0 ? `you are up ${ownBalance}` : `you are down ${-ownBalance}`,
    recent_moves: history.slice(-12),
    notes:
      "board_ascii shows the board from white's side: rank 8 at the top, files a-h left to right. " +
      "Uppercase letters are white pieces, lowercase are black pieces. " +
      "Each legal move is one option; option descriptions are facts computed by the rules engine.",
  };
}

/**
 * Lässt Jev für die Seite am Zug einen Zug wählen.
 * @param {Chess} chess
 * @returns {{ san: string, confidence: number, probabilities: Record<string, number>,
 *             evaluation: number, evaluationLegend: Record<string,string>, tactical: number,
 *             usage: {input_tokens:number, output_tokens:number}, model: string }}
 */
export async function pickMove(chess) {
  const color = chess.turn();
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) throw new Error("no legal moves");

  const criteria = {};
  for (const m of moves) criteria[m.san] = describeMove(chess, m);

  const { answers, usage, model } = await client.systemOne({
    state: buildState(chess, color),
    questions: {
      move: choice(
        {
          question: `Which move should ${PLAYERS[color].name} (${color === "w" ? "white" : "black"}) play now?`,
          guidance: [
            "Never hang material for nothing: avoid moves marked as NOT defended unless they checkmate or win more material.",
            "Prefer captures of higher-value pieces, checks that gain something, and moves that improve piece activity.",
            "In the opening: develop minor pieces, control the centre, castle early.",
            "In the endgame: activate the king, push passed pawns, avoid stalemate when ahead.",
            "Play according to your_style when several moves are equally sound.",
          ],
        },
        criteria,
      ),
      evaluation: score(
        `From the point of view of the side to move (${color === "w" ? "white" : "black"}), how good is this position before the move?`,
        [
          "Lost: decisive material deficit or unavoidable mate against us",
          "Clearly worse: down material or under strong attack",
          "Slightly worse",
          "Equal / balanced",
          "Slightly better",
          "Clearly better: up material or strong attack",
          "Winning: decisive material advantage or forced mate for us",
        ],
      ),
      tactical: noul("Is the position tactically sharp right now, with hanging pieces, checks or capture sequences that must be calculated?"),
    },
  });

  const a = answers.move;
  // Sicherheitsnetz: die Antwort ist immer ein Optionsschlüssel, also ein legaler Zug.
  // Falls das Modell doch etwas anderes liefert, nehmen wir die wahrscheinlichste legale Option.
  let san = a.choice;
  if (!criteria[san]) {
    san = Object.entries(a.probabilities)
      .filter(([k]) => criteria[k])
      .sort((x, y) => y[1] - x[1])[0][0];
  }

  return {
    san,
    confidence: a.confidence,
    probabilities: a.probabilities,
    evaluation: answers.evaluation.score,
    evaluationLegend: answers.evaluation.legend,
    tactical: answers.tactical.noul,
    usage,
    model,
  };
}
