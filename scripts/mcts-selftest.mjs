// Self-test for the tree mechanics, no API calls.
// A deterministic evaluator (material + one-ply mate awareness, near-uniform policy)
// replaces Jev. If the search cannot solve these positions with a perfect-information
// evaluator, the bug is in mcts.js. If it can, the weakness lies in the value signal.
//
// Usage: node scripts/mcts-selftest.mjs [simulations]

import { Chess } from "chess.js";
import { MCTS } from "../mcts.js";

const SIMS = Number(process.argv[2] ?? 200);
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function material(chess) {
  let m = 0;
  for (const row of chess.board()) for (const sq of row) if (sq) m += (sq.color === "w" ? 1 : -1) * VAL[sq.type];
  return m;
}

// Value from the side to move's perspective: material only (no lookahead).
// Policy: uniform with a mild bonus for captures, so priors do not give the answer away.
async function fakeEvaluate(chess) {
  const moves = chess.moves({ verbose: true });
  const sign = chess.turn() === "w" ? 1 : -1;
  const value = Math.tanh((sign * material(chess)) / 6);
  const w = moves.map((m) => (m.captured ? 2 : 1));
  const total = w.reduce((a, b) => a + b, 0);
  const policy = Object.fromEntries(moves.map((m, i) => [m.san, w[i] / total]));
  return { policy, value };
}

const CASES = [
  {
    name: "Mate in 1 (Ra8#)",
    fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
    expect: (san) => san === "Ra8#",
  },
  {
    name: "Capture with mate available (Rxd1#), everything else allows Rxd8#",
    fen: "3r2k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 1",
    expect: (san) => san.startsWith("Rxd1"),
  },
  {
    name: "Poisoned rook: Qxd7+?? Kxd7 loses the queen; Qxa6 wins a free bishop (depth-2)",
    // White Qd3, Ke1. Black Ke8, Rd7 (defended by the king), Ba6 (undefended, not attacking anything relevant).
    fen: "4k3/3r4/b7/8/8/3Q4/8/4K3 w - - 0 1",
    expect: (san) => san === "Qxa6",
  },
  {
    name: "Do not hang the queen: Qxe5?? Nxe5; Qd2 or any quiet move is fine (depth-2)",
    // White Qd1, black knight c6 defends e5 pawn; Qxe5 loses queen to Nxe5.
    fen: "4k3/8/2n5/4p3/8/8/8/3QK3 w - - 0 1",
    expect: (san) => san !== "Qxe5",
  },
];

let failed = 0;
for (const c of CASES) {
  const chess = new Chess(c.fen);
  const mcts = new MCTS({ simulations: SIMS, concurrency: 4, evaluate: fakeEvaluate });
  const r = await mcts.search(chess);
  // Invariants
  const root = mcts.lastRoot;
  const edges = Object.values(root.edges);
  const sumN = edges.reduce((a, e) => a + e.N, 0);
  const badQ = edges.filter((e) => e.N > 0 && Math.abs(e.W / e.N) > 1 + 1e-9);
  const ok = c.expect(r.san);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`      chosen ${r.san}  q=${r.q?.toFixed(2)}  visits=${r.visits}/${sumN}  evaluations=${r.evaluations}/${SIMS}  traversals=${r.traversals}  priorBest=${r.priorBest}${r.reason ? "  [" + r.reason + "]" : ""}`);
  console.log(`      top: ${r.candidates.map((x) => `${x.san} N=${x.visits} Q=${x.q == null ? "–" : x.q.toFixed(2)} P=${x.prior.toFixed(2)}`).join(" | ")}`);
  if (sumN !== r.traversals) { failed++; console.log(`      INVARIANT FAIL: root visits ${sumN} != traversals ${r.traversals}`); }
  if (r.evaluations > SIMS) { failed++; console.log(`      INVARIANT FAIL: evaluations ${r.evaluations} > budget ${SIMS}`); }
  if (badQ.length) { failed++; console.log(`      INVARIANT FAIL: |Q|>1 on ${badQ.length} edges`); }
}
console.log(failed ? `\n${failed} problem(s)` : "\nAll mechanics tests passed");
process.exit(failed ? 1 : 0);
