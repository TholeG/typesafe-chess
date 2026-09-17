// Small, exact tactical helpers computed in code. They cover what a rules
// engine can know for certain and what a coarse judgment model gets wrong:
// forced capture sequences and mate in one. Jev keeps the positional judgment;
// these functions sharpen both the option descriptions (policy) and the leaf
// values (search).

import { Chess } from "chess.js";

export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material balance, positive = White ahead. */
export function material(chess) {
  let m = 0;
  for (const row of chess.board()) for (const sq of row) if (sq) m += (sq.color === "w" ? 1 : -1) * PIECE_VALUES[sq.type];
  return m;
}

/** Material from the perspective of the side to move. */
export function materialFor(chess) {
  return (chess.turn() === "w" ? 1 : -1) * material(chess);
}

/**
 * Capture-only alpha-beta ("quiescence") with stand-pat and MVV-LVA ordering.
 * Returns the material from the side to move's perspective after the best
 * forced capture sequence, i.e. what is really on the board once hanging
 * pieces are taken. When in check there is no stand-pat and every evasion is
 * searched. Depth bounds the number of plies, so this is an estimate, not a proof.
 */
export function quiesce(chess, alpha = -Infinity, beta = Infinity, depth = 6) {
  if (chess.isCheckmate()) return -1000;
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return 0;
  const inCheck = chess.inCheck();
  const standPat = materialFor(chess);
  if (depth === 0) return standPat;
  let best = -Infinity;
  if (!inCheck) {
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    best = standPat;
  }
  const moves = chess
    .moves({ verbose: true })
    .filter((m) => inCheck || m.captured || m.promotion)
    .sort((a, b) => PIECE_VALUES[b.captured ?? "p"] - PIECE_VALUES[a.captured ?? "p"] || PIECE_VALUES[a.piece] - PIECE_VALUES[b.piece]);

  for (const m of moves) {
    chess.move(m.san);
    const score = -quiesce(chess, -beta, -alpha, depth - 1);
    chess.undo();
    if (score > best) best = score;
    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }
  return best;
}

/** Net material the mover gains (or loses, negative) by playing `san`, after forced recaptures. */
export function exchangeOutcome(chess, san) {
  const before = materialFor(chess);
  const probe = new Chess(chess.fen());
  probe.move(san);
  if (probe.isCheckmate()) return 1000;
  const after = -quiesce(probe); // from our perspective again
  return after - before;
}

/**
 * Legal replies across the whole board; absence of a recapture is not
 * a proof of material loss. Return at most two examples of each kind.
 */
export function forcingReplyFacts(chess) {
  if (chess.isGameOver()) return {};
  const probe = new Chess(chess.fen());
  const capturedSquare = (m) => m.flags.includes("e")
    ? m.to[0] + m.from[1] : m.to;
  const captures = [], checks = [];
  for (const m of probe.moves({ verbose: true })) {
    const check = /[+#]$/.test(m.san);
    if (!m.captured && !check) continue;
    probe.move(m.san);
    const replies = probe.moves({ verbose: true });
    const recaptured = replies.some((r) =>
      r.captured && capturedSquare(r) === m.to);
    if (m.captured && !recaptured) {
      captures.push({
        san: m.san, victim: m.captured + capturedSquare(m),
        value: PIECE_VALUES[m.captured],
      });
    }
    if (check && !recaptured) {
      checks.push({ san: m.san, replies: replies.map((r) => r.san) });
    }
    probe.undo();
  }
  captures.sort((a, b) => b.value - a.value || a.san.localeCompare(b.san));
  checks.sort((a, b) =>
    a.replies.length - b.replies.length || a.san.localeCompare(b.san));
  const facts = {};
  if (captures.length) facts.captures_without_recapture =
    captures.slice(0, 2).map(({ san, victim }) => ({ san, victim }));
  if (checks.length) facts.checks_without_checker_capture =
    checks.slice(0, 2).map(({ san, replies }) => ({
      san, evasions: replies.length <= 3 ? replies : replies.length,
    }));
  return facts;
}

/** SAN of a mating move for the side to move, or null. */
export function mateInOne(chess) {
  for (const m of chess.moves()) if (m.endsWith("#")) return m;
  return null;
}

/**
 * Can the side to move be mated next move by the opponent no matter what?
 * Cheap approximation used as a fact: true when the opponent has a mate in one
 * right now if it were their turn AND every legal move still allows a mate in one.
 * Returns true/false.
 */
export function facesForcedMate(chess) {
  const moves = chess.moves();
  if (moves.length === 0) return false;
  for (const san of moves) {
    const probe = new Chess(chess.fen());
    probe.move(san);
    if (probe.isGameOver()) return false;
    if (!mateInOne(probe)) return false;
  }
  return true;
}
