// Jev as a chess player.
//
// Division of labour, the TypeSafe way: chess.js knows the rules and
// generates the legal moves (code). Jev receives the position plus a
// description of every legal move as Choice options and picks one
// (judgment). In the same call we also ask for a position score (Score)
// and whether the position is tactically sharp (Noul). Both are display
// signals only and do not influence the move.

import { Chess } from "chess.js";
import { TypeSafeClient, choice, score, noul } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ timeout: 20000 });

const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Two playing styles so the two Jev instances differ.
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
  return sum; // positive = white is ahead
}

// After this move, can the opponent capture the moved piece on its destination square?
function attackedAfter(chess, move) {
  const probe = new Chess(chess.fen());
  probe.move(move.san);
  if (probe.isGameOver()) return { attacked: false, defended: false };
  const enemy = probe.moves({ verbose: true }).filter((m) => m.to === move.to && m.captured);
  if (enemy.length === 0) return { attacked: false, defended: false };
  // Defended? Check whether a recapture exists after the cheapest enemy capture.
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

const SCORE_LEVELS = [
  "Lost: decisive material deficit or unavoidable mate against us",
  "Clearly worse: down material or under strong attack",
  "Slightly worse",
  "Equal / balanced",
  "Slightly better",
  "Clearly better: up material or strong attack",
  "Winning: decisive material advantage or forced mate for us",
];
const SCORE_MID = (SCORE_LEVELS.length - 1) / 2; // 3 = "Equal"

/**
 * One Jev call for one position: policy over legal moves, value of the position
 * and two display signals. This is the single building block for both the
 * fast player (one call per move) and the MCTS player (one call per tree node).
 *
 * @param {Chess} chess
 * @returns {Promise<{
 *   policy: Record<string, number>, confidence: number,
 *   value: number,                 // [-1, 1] from the side to move's perspective
 *   evaluation: number, evaluationLegend: Record<string,string>, tactical: number,
 *   usage: {input_tokens:number, output_tokens:number}, model: string }>}
 */
export async function evaluatePosition(chess) {
  const color = chess.turn();
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) throw new Error("no legal moves");

  const criteria = {};
  for (const m of moves) criteria[m.san] = describeMove(chess, m);
  const side = color === "w" ? "white" : "black";

  const { answers, usage, model } = await client.systemOne({
    state: buildState(chess, color),
    questions: {
      move: choice(
        {
          question: `Which move should ${PLAYERS[color].name} (${side}) play now?`,
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
        `From the point of view of the side to move (${side}), how good is this position before the move?`,
        SCORE_LEVELS,
      ),
      tactical: noul("Is the position tactically sharp right now, with hanging pieces, checks or capture sequences that must be calculated?"),
    },
  });

  // Safety net: keep only probabilities for legal moves and renormalise.
  const policy = {};
  let total = 0;
  for (const [san, p] of Object.entries(answers.move.probabilities)) {
    if (criteria[san]) { policy[san] = p; total += p; }
  }
  if (total <= 0) { for (const m of moves) policy[m.san] = 1 / moves.length; total = 1; }
  for (const san in policy) policy[san] /= total;

  return {
    policy,
    confidence: answers.move.confidence,
    value: (answers.evaluation.score - SCORE_MID) / SCORE_MID,
    evaluation: answers.evaluation.score,
    evaluationLegend: answers.evaluation.legend,
    tactical: answers.tactical.noul,
    usage,
    model,
  };
}

/**
 * Fast player: a single Jev call, play the most probable move.
 */
export async function pickMove(chess) {
  const ev = await evaluatePosition(chess);
  const san = Object.entries(ev.policy).sort((a, b) => b[1] - a[1])[0][0];
  return { san, probabilities: ev.policy, ...ev };
}
