// Monte Carlo Tree Search with Jev as policy and value network.
//
// AlphaZero-style PUCT search without rollouts:
//   - Policy prior for each legal move  = Jev's Choice probability distribution
//   - Value of a leaf position          = Jev's Score, mapped to [-1, 1]
// Every tree node costs exactly one Jev call; transpositions are cached by
// position. Several leaves are evaluated concurrently using virtual loss.
//
// The search improves on the single-call player in two ways: it verifies
// Jev's favourite moves by looking at the resulting positions with fresh
// eyes, and it lets the opponent's best replies (as Jev sees them) punish
// moves that only look good on the surface.

import { Chess } from "chess.js";
import { evaluatePosition } from "./jev-player.js";

const VIRTUAL_LOSS = 1;

function cacheKey(chess) {
  // Ignore the half-move and full-move counters so transpositions hit.
  return chess.fen().split(" ").slice(0, 4).join(" ");
}

function terminalValue(chess) {
  if (!chess.isGameOver()) return null;
  return chess.isCheckmate() ? -1 : 0; // side to move is mated, or draw
}

class Node {
  constructor(fen) {
    this.fen = fen;
    this.chess = new Chess(fen);
    this.terminal = terminalValue(this.chess);
    this.expanded = false;
    this.value = null; // Jev's value from the side to move's perspective
    this.edges = null; // san -> { P, N, W, child }  (W from this node's mover perspective)
  }
}

export class MCTS {
  /**
   * @param {object} opts
   * @param {number} [opts.simulations=16]  tree expansions per move (≈ Jev calls minus cache hits)
   * @param {number} [opts.concurrency=4]   parallel leaf evaluations
   * @param {number} [opts.cpuct=1.5]       exploration constant
   */
  constructor(opts = {}) {
    this.simulations = opts.simulations ?? 16;
    this.concurrency = opts.concurrency ?? 4;
    this.cpuct = opts.cpuct ?? 1.5;
    this.cache = new Map(); // cacheKey -> evaluation (or pending promise)
    this.stats = { evaluations: 0, cacheHits: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: null };
  }

  async evaluate(node) {
    const key = cacheKey(node.chess);
    let entry = this.cache.get(key);
    if (entry) {
      this.stats.cacheHits++;
    } else {
      entry = evaluatePosition(node.chess).then((ev) => {
        this.stats.evaluations++;
        this.stats.usage.input_tokens += ev.usage.input_tokens;
        this.stats.usage.output_tokens += ev.usage.output_tokens;
        this.stats.model = ev.model;
        this.cache.set(key, ev);
        return ev;
      });
      this.cache.set(key, entry);
    }
    const ev = await entry;
    if (!node.expanded) {
      node.value = ev.value;
      node.eval = ev;
      node.edges = {};
      for (const [san, P] of Object.entries(ev.policy)) node.edges[san] = { P, N: 0, W: 0, child: null };
      node.expanded = true;
    }
    return ev;
  }

  select(node) {
    const sqrtN = Math.sqrt(1 + Object.values(node.edges).reduce((a, e) => a + e.N, 0));
    // First-play urgency: unvisited moves inherit the parent's value minus a small penalty,
    // so the search does not have to try every move before trusting the prior.
    const fpu = (node.value ?? 0) - 0.2;
    let best = null, bestScore = -Infinity;
    for (const [san, e] of Object.entries(node.edges)) {
      const Q = e.N > 0 ? e.W / e.N : fpu;
      const U = this.cpuct * e.P * (sqrtN / (1 + e.N));
      const s = Q + U;
      if (s > bestScore) { bestScore = s; best = san; }
    }
    return best;
  }

  async simulate(root) {
    const path = [];
    let node = root;
    while (node.expanded && node.terminal === null) {
      const san = this.select(node);
      const edge = node.edges[san];
      edge.N += VIRTUAL_LOSS; edge.W -= VIRTUAL_LOSS;
      path.push(edge);
      if (!edge.child) {
        const c = new Chess(node.fen);
        c.move(san);
        edge.child = new Node(c.fen());
      }
      node = edge.child;
    }
    let v;
    if (node.terminal !== null) v = node.terminal;
    else v = (await this.evaluate(node)).value;

    // v is from the perspective of the side to move at the leaf. The edge leading
    // into the leaf was chosen by the opponent, so its value is -v, alternating upwards.
    let val = -v;
    for (let i = path.length - 1; i >= 0; i--) {
      const e = path[i];
      e.W += val + VIRTUAL_LOSS; // undo virtual loss, add real value (N already counted)
      val = -val;
    }
  }

  /**
   * Search the position and return the chosen move plus diagnostics.
   * @param {Chess} chess
   */
  async search(chess) {
    this.stats = { evaluations: 0, cacheHits: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: null };
    const root = new Node(chess.fen());
    const rootEval = await this.evaluate(root);

    let launched = 0;
    const worker = async () => {
      while (launched < this.simulations) {
        launched++;
        await this.simulate(root);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, worker));

    const edges = Object.entries(root.edges).map(([san, e]) => ({
      san, prior: e.P, visits: e.N, q: e.N > 0 ? e.W / e.N : null,
    }));
    edges.sort((a, b) => b.visits - a.visits || (b.q ?? -2) - (a.q ?? -2) || b.prior - a.prior);
    const chosen = edges[0];
    const priorBest = [...edges].sort((a, b) => b.prior - a.prior)[0];

    return {
      san: chosen.san,
      q: chosen.q,
      visits: chosen.visits,
      priorBest: priorBest.san,
      changedBySearch: priorBest.san !== chosen.san,
      candidates: edges.slice(0, 5),
      rootEval,
      simulations: this.simulations,
      ...this.stats,
    };
  }
}
