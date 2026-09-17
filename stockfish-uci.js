// Minimal UCI wrapper around the `stockfish` npm package (WASM build, runs in Node).
// Used only by the test and benchmark scripts as an external, deterministic reference:
// an oracle that scores every legal move, and a sparring partner of adjustable strength.
//
// Scores are always from the perspective of the side to move in the given position.
// Mates are folded into centipawns as ±(MATE - plies) so they sort correctly.

import { createRequire } from "node:module";
import { Chess } from "chess.js";

const require = createRequire(import.meta.url);
const initStockfish = require("stockfish");

export const MATE = 100000;

export async function createEngine({ flavor = "lite-single", hash = 32, skillLevel = null, elo = null } = {}) {
  // The engine module keeps state at module level, so a second instance in the same
  // process needs a fresh evaluation of the file: drop it from the require cache.
  const version = require("stockfish/package.json").buildVersion;
  const suffix = { full: "", lite: "-lite", single: "-single", "lite-single": "-lite-single", asm: "-asm" }[flavor] ?? "";
  try { delete require.cache[require.resolve(`stockfish/bin/stockfish-${version}${suffix}.js`)]; } catch {}
  // The Emscripten loader sets the global `fetch` to null in Node, which breaks every
  // other HTTP client in the process (including the TypeSafe SDK). Restore it.
  const savedFetch = globalThis.fetch;
  const raw = await initStockfish(flavor);
  if (typeof globalThis.fetch !== "function" && savedFetch) globalThis.fetch = savedFetch;
  const waiters = []; // { test(line) -> value|undefined, resolve }
  const lines = [];
  raw.listener = (line) => {
    lines.push(line);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const v = waiters[i].test(line);
      if (v !== undefined) { waiters.splice(i, 1)[0].resolve(v); }
    }
  };

  const send = (cmd) => raw.sendCommand(cmd);
  const waitFor = (test) => new Promise((resolve) => waiters.push({ test, resolve }));
  const ready = async () => { send("isready"); await waitFor((l) => (l === "readyok" ? true : undefined)); };

  send("uci");
  await waitFor((l) => (l === "uciok" ? true : undefined));
  send(`setoption name Hash value ${hash}`);

  /** Change playing strength between games. elo=null removes the limit. */
  async function setStrength({ elo = null, skillLevel = null } = {}) {
    send(`setoption name Skill Level value ${skillLevel ?? 20}`);
    send(`setoption name UCI_LimitStrength value ${elo != null}`);
    if (elo != null) send(`setoption name UCI_Elo value ${elo}`);
    send("ucinewgame");
    await ready();
  }
  await setStrength({ elo, skillLevel });

  /** Run `go` on a position and return { bestmove (LAN), score (cp, mover's view), pv }. */
  async function go(fen, moves = [], { depth = 10, movetime = null } = {}) {
    lines.length = 0;
    send(`position fen ${fen}${moves.length ? " moves " + moves.join(" ") : ""}`);
    send(movetime ? `go movetime ${movetime}` : `go depth ${depth}`);
    const bestmove = await waitFor((l) => (l.startsWith("bestmove") ? l.split(" ")[1] : undefined));
    let score = null, pv = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /score (cp|mate) (-?\d+)/.exec(lines[i]);
      if (m && lines[i].includes(" pv ")) {
        score = m[1] === "cp" ? Number(m[2]) : Math.sign(Number(m[2])) * (MATE - Math.abs(Number(m[2])));
        pv = lines[i].split(" pv ")[1].split(" ");
        break;
      }
    }
    return { bestmove, score, pv };
  }

  const lan = (m) => m.from + m.to + (m.promotion ?? "");

  return {
    /** Best move as SAN plus score from the mover's view. */
    async bestMove(chess, opts) {
      const r = await go(chess.fen(), [], opts);
      if (!r.bestmove || r.bestmove === "(none)") return null;
      const probe = new Chess(chess.fen());
      const mv = probe.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: r.bestmove[4] });
      return { san: mv.san, score: r.score };
    },

    /** Score every legal move: san -> centipawns from the mover's view (higher is better). */
    async scoreMoves(chess, opts) {
      const out = {};
      for (const m of chess.moves({ verbose: true })) {
        const probe = new Chess(chess.fen());
        probe.move(m.san);
        if (probe.isCheckmate()) { out[m.san] = MATE; continue; }
        if (probe.isDraw()) { out[m.san] = 0; continue; }
        const r = await go(chess.fen(), [lan(m)], opts);
        out[m.san] = r.score == null ? 0 : -r.score; // reply score is from the opponent's view
      }
      return out;
    },

    /** Static-ish evaluation of the position from the mover's view. */
    async evaluate(chess, opts) {
      return (await go(chess.fen(), [], opts)).score;
    },

    setStrength,
    newGame: async () => { send("ucinewgame"); await ready(); },
    quit() { send("quit"); },
  };
}
