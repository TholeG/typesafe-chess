// Monte Carlo Tree Search with Jev as policy and value network.
//
// AlphaZero-style PUCT search without rollouts:
//   - Policy prior for each legal move  = Jev's Choice probability distribution
//   - Value of a leaf position          = Jev's Score mapped to [-1, 1], blended with
//                                         an exact code-side tactical delta (see hybridValue)
// Every new tree node costs one Jev call; transpositions are cached by position.
// Several leaves are evaluated concurrently using virtual loss.
//
// Budget semantics: `simulations` is the number of NEW position evaluations
// (API calls) per move, excluding the root. Cache hits and collisions on nodes
// that are still being evaluated do not consume budget.

import { Chess } from "chess.js";
import { evaluatePosition } from "./jev-player.js";
import { materialFor, quiesce, mateInOne } from "./tactics.js";

const VIRTUAL_LOSS = 1;
const MAX_TRAVERSALS_PER_SIM = 4; // guard against spinning on cache hits

const posKey = (chess) => chess.fen().split(" ").slice(0, 4).join(" "); // repetition identity
const cacheKey = (chess) => chess.fen().split(" ").slice(0, 5).join(" "); // + half-move clock (affects draw facts)

/**
 * Hybrid leaf value. Jev's Score saturates once one side is materially ahead
 * ("clearly better" for every move), so on its own it cannot rank the children
 * of a won or lost position. Code adds what it can compute exactly: the change
 * in material relative to the root after all forced captures, and mate in one.
 * Both are from the perspective of the side to move at the leaf.
 */
export function hybridValue(jevValue, chess, rootMaterialWhite, weight = 0.5) {
  if (mateInOne(chess)) return 1;
  const sign = chess.turn() === "w" ? 1 : -1;
  const rootFromMover = sign * rootMaterialWhite;
  const settled = quiesce(new Chess(chess.fen()));
  if (settled <= -1000) return -1;
  const delta = settled - rootFromMover;
  const tactical = Math.tanh(delta / 3);
  return Math.max(-1, Math.min(1, (1 - weight) * jevValue + weight * tactical));
}

class Node {
  /**
   * @param {Chess} chess       position (its own instance, not shared)
   * @param {string[]} history  SAN moves from the start of the game to this node
   * @param {Map<string,number>} posCounts  repetition counts along game + path
   */
  constructor(chess, history, posCounts) {
    this.chess = chess;
    this.fen = chess.fen();
    this.history = history;
    this.posCounts = posCounts;
    const reps = posCounts.get(posKey(chess)) ?? 0;
    this.terminal = chess.isCheckmate() ? -1 : chess.isDraw() || reps >= 3 ? 0 : null;
    this.expanded = false;
    this.pending = null; // promise while this node is being evaluated
    this.jevValue = null;
    this.value = null; // backed-up leaf value, side-to-move perspective
    this.edges = null; // san -> { P, N, W, child }, W from this node's mover perspective
  }

  child(san) {
    const c = new Chess(this.fen);
    c.move(san);
    const counts = new Map(this.posCounts);
    const k = posKey(c);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    return new Node(c, [...this.history, san], counts);
  }
}

function gamePositionCounts(chess) {
  // Replay the game's history so repetitions before the root are counted.
  const counts = new Map();
  const replay = new Chess();
  try {
    counts.set(posKey(replay), 1);
    for (const san of chess.history()) {
      replay.move(san);
      const k = posKey(replay);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (posKey(replay) !== posKey(chess)) throw new Error("history does not reach the current position");
  } catch {
    // Position was loaded from a FEN without history: count only the root.
    counts.clear();
    counts.set(posKey(chess), 1);
  }
  return counts;
}

export class MCTS {
  /**
   * @param {object} opts
   * @param {number} [opts.simulations=16]  new evaluations (API calls) per move, root excluded
   * @param {number} [opts.concurrency=4]   parallel leaf evaluations
   * @param {number} [opts.cpuct=1.5]       exploration constant
   * @param {(chess: Chess, extra?: {history: string[]}) => Promise<{policy: Record<string,number>, value: number}>} [opts.evaluate]
   *        position evaluator; defaults to Jev. Injectable for tests.
   * @param {number} [opts.tacticalWeight=0.5] share of the leaf value taken from the code-side
   *        tactical delta (0 = pure Jev value, 1 = pure material/mate search).
   * @param {"q"|"visits"} [opts.selection="q"] final choice: Q among well-covered moves, or most visits
   * @param {number} [opts.minVisitFraction=0.5] coverage needed (share of the max visits) to rank by Q
   * @param {number} [opts.minVisits=2] absolute minimum visits to rank by Q
   * @param {number} [opts.fpuPenalty=0.2] first-play urgency penalty below the parent's value
   */
  constructor(opts = {}) {
    this.simulations = opts.simulations ?? 16;
    this.concurrency = opts.concurrency ?? 4;
    this.cpuct = opts.cpuct ?? 1.5;
    this.evaluateFn = opts.evaluate ?? evaluatePosition;
    this.tacticalWeight = opts.tacticalWeight ?? 0.5;
    this.selection = opts.selection ?? "q";
    this.minVisitFraction = opts.minVisitFraction ?? 0.5;
    this.minVisits = opts.minVisits ?? 2;
    this.fpuPenalty = opts.fpuPenalty ?? 0.2;
    this.cache = new Map(); // cacheKey -> resolved evaluation
    this.rootMaterial = 0;
    this.stats = this.freshStats();
  }

  freshStats() {
    return { evaluations: 0, inflight: 0, cacheHits: 0, pendingCollisions: 0, traversals: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: null };
  }

  /** Ensure a node is expanded (policy + value present). Returns the node's value. */
  async evaluate(node, stats) {
    if (!node.expanded) {
      if (!node.pending) {
        const key = cacheKey(node.chess);
        const cached = this.cache.get(key);
        if (cached) {
          stats.cacheHits++;
          node.pending = Promise.resolve(cached);
        } else {
          stats.inflight++;
          node.pending = this.evaluateFn(node.chess, { history: node.history }).then((ev) => {
            stats.inflight--;
            stats.evaluations++;
            stats.usage.input_tokens += ev.usage?.input_tokens ?? 0;
            stats.usage.output_tokens += ev.usage?.output_tokens ?? 0;
            stats.model = ev.model ?? stats.model;
            this.cache.set(key, ev);
            return ev;
          }, (err) => { stats.inflight--; throw err; });
        }
      } else {
        stats.pendingCollisions++;
      }
      let ev;
      try {
        ev = await node.pending;
      } catch (err) {
        node.pending = null; // allow a retry on a later traversal
        throw err;
      }
      if (!node.expanded) {
        node.jevValue = ev.value;
        node.value = this.tacticalWeight > 0 ? hybridValue(ev.value, node.chess, this.rootMaterial, this.tacticalWeight) : ev.value;
        node.eval = ev;
        node.edges = {};
        for (const [san, P] of Object.entries(ev.policy)) node.edges[san] = { P, N: 0, W: 0, child: null };
        node.expanded = true;
      }
    }
    return node.value;
  }

  select(node) {
    const sqrtN = Math.sqrt(1 + Object.values(node.edges).reduce((a, e) => a + e.N, 0));
    // First-play urgency: unvisited moves inherit the parent's value minus a small penalty,
    // so the search does not have to try every move before trusting the prior.
    const fpu = Math.max(-1, (node.value ?? 0) - this.fpuPenalty);
    let best = null, bestScore = -Infinity;
    for (const [san, e] of Object.entries(node.edges)) {
      const Q = e.N > 0 ? e.W / e.N : fpu;
      const U = this.cpuct * e.P * (sqrtN / (1 + e.N));
      const s = Q + U;
      if (s > bestScore) { bestScore = s; best = san; }
    }
    return best;
  }

  async simulate(root, stats) {
    const path = [];
    try {
      let node = root;
      while (node.expanded && node.terminal === null) {
        const san = this.select(node);
        const edge = node.edges[san];
        edge.N += VIRTUAL_LOSS; edge.W -= VIRTUAL_LOSS;
        path.push(edge);
        if (!edge.child) edge.child = node.child(san);
        node = edge.child;
      }
      const v = node.terminal !== null ? node.terminal : await this.evaluate(node, stats);

      // v is from the perspective of the side to move at the leaf. The edge leading
      // into the leaf was chosen by the opponent, so its value is -v, alternating upwards.
      let val = -v;
      for (let i = path.length - 1; i >= 0; i--) {
        path[i].W += val + VIRTUAL_LOSS; // undo virtual loss, add real value (N already counted)
        val = -val;
      }
    } catch (err) {
      for (const e of path) { e.N -= VIRTUAL_LOSS; e.W += VIRTUAL_LOSS; } // release reservations
      throw err;
    }
  }

  /**
   * Search the position and return the chosen move plus diagnostics.
   * @param {Chess} chess
   */
  async search(chess) {
    if (chess.isGameOver()) throw new Error("search called on a finished game");
    const stats = this.freshStats();
    this.stats = stats;
    this.rootMaterial = (chess.turn() === "w" ? 1 : -1) * materialFor(chess); // White's perspective
    const root = new Node(new Chess(chess.fen()), chess.history(), gamePositionCounts(chess));
    await this.evaluate(root, stats);
    const rootEval = root.eval;

    const maxTraversals = this.simulations * MAX_TRAVERSALS_PER_SIM;
    let failure = null;
    const worker = async () => {
      try {
        while (!failure && stats.evaluations + stats.inflight < this.simulations && stats.traversals < maxTraversals) {
          stats.traversals++;
          await this.simulate(root, stats);
        }
      } catch (err) {
        failure = failure ?? err;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, worker));
    if (failure) throw failure;

    // Exact tactical status of every root move, computed in code: an immediate mate
    // is always played; moves that allow a mate in one are excluded when possible.
    const edges = Object.entries(root.edges).map(([san, e]) => {
      const c = new Chess(root.fen);
      c.move(san);
      const matesNow = c.isCheckmate();
      const allowsMate = !matesNow && !c.isGameOver() && mateInOne(c) !== null;
      return { san, prior: e.P, visits: e.N, q: e.N > 0 ? e.W / e.N : null, matesNow, allowsMate };
    });
    // Final choice. With a small budget, visit counts mostly mirror the prior, so we
    // rank by Q among moves that received comparable coverage (at least half of the
    // most-visited move's visits, minimum 2) and fall back to visits below that.
    const maxVisits = Math.max(0, ...edges.map((e) => e.visits));
    const minVisits = Math.max(this.minVisits, Math.ceil(maxVisits * this.minVisitFraction));
    const byVisits = (a, b) => b.visits - a.visits || (b.q ?? -2) - (a.q ?? -2) || b.prior - a.prior;
    const byStrength = this.selection === "visits" ? byVisits : (a, b) => {
      const aOk = a.visits >= minVisits, bOk = b.visits >= minVisits;
      if (aOk !== bOk) return aOk ? -1 : 1;
      if (aOk && bOk) return (b.q ?? -2) - (a.q ?? -2) || b.visits - a.visits || b.prior - a.prior;
      return byVisits(a, b);
    };
    edges.sort(byStrength);
    const priorBest = [...edges].sort((a, b) => b.prior - a.prior)[0];

    let chosen = edges.find((e) => e.matesNow);
    let reason = chosen ? "mate in one" : null;
    if (!chosen) {
      const safe = edges.filter((e) => !e.allowsMate);
      chosen = safe.length ? safe[0] : edges[0];
      reason = safe.length && safe.length < edges.length ? `avoided ${edges.length - safe.length} move(s) that allow mate in one` : null;
    }

    this.lastRoot = root; // for inspection tools
    return {
      san: chosen.san,
      q: chosen.q,
      visits: chosen.visits,
      priorBest: priorBest.san,
      changedBySearch: priorBest.san !== chosen.san,
      reason,
      candidates: edges.slice(0, 5).map(({ san, prior, visits, q }) => ({ san, prior, visits, q })),
      rootEval,
      simulations: this.simulations,
      ...stats,
    };
  }
}
