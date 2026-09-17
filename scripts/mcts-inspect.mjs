// Inspect what the search "saw" in one position, with the real Jev evaluator.
// Prints root candidates (prior, visits, Q), the principal variation with Jev's
// value at each node, and the replies Jev considers strongest after the chosen move.
//
// Usage: node scripts/mcts-inspect.mjs "<fen>" [simulations] [concurrency]
//    or: node scripts/mcts-inspect.mjs --pgn "1. e4 e5 ..." <plies> [simulations]

import { Chess } from "chess.js";
import { MCTS } from "../mcts.js";

let fen, sims = 16, conc = 6;
if (process.argv[2] === "--pgn") {
  const c = new Chess();
  const sans = process.argv[3].replace(/\d+\.\s*/g, "").trim().split(/\s+/);
  const plies = Number(process.argv[4]);
  for (const san of sans.slice(0, plies)) c.move(san);
  fen = c.fen();
  sims = Number(process.argv[5] ?? sims);
} else {
  fen = process.argv[2];
  sims = Number(process.argv[3] ?? sims);
  conc = Number(process.argv[4] ?? conc);
}

const chess = new Chess(fen);
console.log(chess.ascii());
console.log(`${chess.turn() === "w" ? "White" : "Black"} to move · ${fen}\n`);

const mcts = new MCTS({ simulations: sims, concurrency: conc });
const t = Date.now();
const r = await mcts.search(chess);
console.log(`Chosen: ${r.san}  (Q ${r.q?.toFixed(2)}, ${r.visits} visits)  prior favourite: ${r.priorBest}  ${r.changedBySearch ? "← overruled" : "← confirmed"}`);
console.log(`${r.evaluations} Jev calls, ${r.cacheHits} cache hits, ${((Date.now() - t) / 1000).toFixed(1)} s, root value ${r.rootEval.value.toFixed(2)} (score ${r.rootEval.evaluation.toFixed(2)})\n`);

const root = mcts.lastRoot;
const rows = Object.entries(root.edges)
  .map(([san, e]) => ({ san, P: e.P, N: e.N, Q: e.N ? e.W / e.N : null, childV: e.child?.value ?? null, term: e.child?.terminal ?? null }))
  .sort((a, b) => b.N - a.N || b.P - a.P)
  .slice(0, 10);
console.log("Root candidates (childV = Jev's value for the opponent after the move; good for us when negative):");
console.table(rows.map((x) => ({ move: x.san, prior: x.P.toFixed(3), visits: x.N, Q: x.Q == null ? "–" : x.Q.toFixed(2), childV: x.term != null ? `terminal ${x.term}` : x.childV == null ? "–" : x.childV.toFixed(2) })));

// Principal variation
let node = root, pv = [];
while (node?.expanded && node.terminal === null) {
  const [san, e] = Object.entries(node.edges).sort((a, b) => b[1].N - a[1].N)[0];
  if (!e.N) break;
  pv.push(`${san} (N${e.N} Q${(e.W / e.N).toFixed(2)}${e.child?.value != null ? ` v${e.child.value.toFixed(2)}` : ""})`);
  node = e.child;
}
console.log("\nPrincipal variation:", pv.join("  →  "));

// What does Jev think the opponent does after the chosen move?
const chosenChild = root.edges[r.san].child;
if (chosenChild?.expanded) {
  const replies = Object.entries(chosenChild.edges).sort((a, b) => b[1].P - a[1].P).slice(0, 5)
    .map(([san, e]) => `${san} P${e.P.toFixed(2)} N${e.N}${e.N ? ` Q${(e.W / e.N).toFixed(2)}` : ""}`);
  console.log(`After ${r.san}, opponent's top replies by prior:`, replies.join(" | "));
}
