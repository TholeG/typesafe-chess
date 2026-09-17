import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const STYLES = {
  w: "Active: open lines, quick development, initiative",
  b: "Solid: king safety, structure, counterpunch",
};

const pct = (x) => `${Math.round(x * 100)} %`;
const fmtQ = (q) => (q == null ? "–" : `${q >= 0 ? "+" : ""}${q.toFixed(2)}`);
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function api(path, method = "GET", body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

// Score is reported from the mover's perspective on a 0..6 scale; convert to White's view.
function whiteScore(entry) {
  if (!entry) return 3;
  return entry.color === "w" ? entry.evaluation : 6 - entry.evaluation;
}

export default function App() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  const [thinking, setThinking] = useState(false);
  const [auto, setAuto] = useState(false);
  const [delay, setDelay] = useState(750);
  const [viewPly, setViewPly] = useState(null); // null = live position
  const autoRef = useRef(false);
  const timerRef = useRef(null);

  const refresh = useCallback(async () => setS(await api("/api/state")), []);
  useEffect(() => { refresh().catch((e) => setErr(e.message)); }, [refresh]);

  const step = useCallback(async () => {
    setThinking(true); setErr("");
    try {
      const next = await api("/api/step", "POST");
      setS(next); setViewPly(null);
      return next;
    } catch (e) {
      setErr(e.message); autoRef.current = false; setAuto(false);
      return null;
    } finally { setThinking(false); }
  }, []);

  const loop = useCallback(async () => {
    if (!autoRef.current) return;
    const next = await step();
    if (autoRef.current && next && !next.gameOver) timerRef.current = setTimeout(loop, delay);
    else { autoRef.current = false; setAuto(false); }
  }, [step, delay]);

  const toggleAuto = () => {
    clearTimeout(timerRef.current);
    const on = !autoRef.current;
    autoRef.current = on; setAuto(on);
    if (on) loop();
  };
  const newGame = async () => {
    clearTimeout(timerRef.current); autoRef.current = false; setAuto(false);
    setS(await api("/api/new", "POST")); setViewPly(null); setErr("");
  };
  const updateSettings = async (patch) => {
    const st = { ...s.settings, ...patch };
    setS(await api("/api/settings", "POST", st));
  };

  // Which position and which move analysis are on screen
  const log = s?.log ?? [];
  const live = log[log.length - 1] ?? null;
  const shown = viewPly == null ? live : log[viewPly - 1] ?? null;
  const fen = viewPly == null ? (s?.fen ?? START_FEN) : viewPly === 0 ? START_FEN : log[viewPly - 1].fenAfter;

  const boardOptions = useMemo(() => {
    const squareStyles = {};
    if (shown) {
      squareStyles[shown.from] = { background: "rgba(255, 214, 0, .45)" };
      squareStyles[shown.to] = { background: "rgba(255, 214, 0, .55)" };
    }
    const arrows = [];
    if (shown?.candidates) {
      const isMcts = shown.mode === "mcts";
      const max = Math.max(...shown.candidates.map((c) => (isMcts ? c.visits : c.prior)), 1e-9);
      [...shown.candidates].reverse().forEach((c) => {
        if (!c.from || !c.to) return;
        const w = (isMcts ? c.visits : c.prior) / max;
        if (c.san === shown.san) arrows.push({ startSquare: c.from, endSquare: c.to, color: "rgba(91,157,255,.95)" });
        else if (w > 0.05) arrows.push({ startSquare: c.from, endSquare: c.to, color: `rgba(143,180,230,${(0.25 + 0.5 * w).toFixed(2)})` });
      });
    }
    return {
      id: "jev-board",
      position: fen,
      allowDragging: false,
      allowDrawingArrows: false,
      showNotation: true,
      animationDurationInMs: 250,
      squareStyles,
      arrows,
      darkSquareStyle: { backgroundColor: "#6e8aa8" },
      lightSquareStyle: { backgroundColor: "#dfe6ee" },
      darkSquareNotationStyle: { color: "#dfe6ee", fontSize: "10px" },
      lightSquareNotationStyle: { color: "#6e8aa8", fontSize: "10px" },
      boardStyle: { borderRadius: "10px", overflow: "hidden" },
    };
  }, [fen, shown]);

  if (!s) return <div className="app"><p className="empty">{err || "Loading…"}</p></div>;

  const side = s.turn === "w" ? s.players.w : s.players.b;
  const busy = thinking || s.busy;
  const ws = whiteScore(live);
  const isMcts = shown?.mode === "mcts";

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="logo">♞</div>
          <div>
            <h1>Jev vs Jev</h1>
            <p>Both players decide with <a href="https://typesafe.ai" target="_blank" rel="noreferrer">TypeSafe</a> System One · code owns the rules, Jev supplies the judgment</p>
          </div>
        </div>
        <div className="badge">model <b>{live?.model ?? "jev-latest"}</b></div>
      </header>

      <div className="grid">
        <div className="board-col">
          <PlayerCard color="b" name={s.players.b} active={!s.gameOver && s.turn === "b"} busy={busy && s.turn === "b"} />

          <div className="board-wrap">
            <div className="evalbar" title={`Position score (White's view): ${ws.toFixed(2)} / 6`}>
              <div className="white" style={{ height: `${(ws / 6) * 100}%` }} />
              <div className="mid" />
              <div className="label top">{ws < 3 ? (3 - ws).toFixed(1) : ""}</div>
              <div className="label bottom">{ws >= 3 ? (ws - 3).toFixed(1) : ""}</div>
            </div>
            <div className="board-shell">
              <Chessboard options={boardOptions} />
            </div>
          </div>

          <PlayerCard color="w" name={s.players.w} active={!s.gameOver && s.turn === "w"} busy={busy && s.turn === "w"} />

          <div className="controls">
            <button onClick={newGame} disabled={busy}>New game</button>
            <button className="primary" onClick={step} disabled={busy || s.gameOver || auto}>One move</button>
            <button onClick={toggleAuto} disabled={s.gameOver && !auto}>{auto ? "⏸ Stop" : "▶ Autoplay"}</button>
            <label className="range">
              Delay
              <input type="range" min="0" max="3000" step="250" value={delay} onChange={(e) => setDelay(+e.target.value)} />
              <span className="mono">{(delay / 1000).toFixed(2)} s</span>
            </label>
          </div>

          <div className={`status ${s.gameOver ? "over" : ""}`}>
            <div className="main">
              {s.gameOver ? s.result : busy ? `${side} is thinking…` : `${side} to move${s.inCheck ? " · check" : ""} · move ${s.moveNumber}`}
            </div>
            <div className="sub mono">
              {log.length} plies · {fmtTokens(s.totalUsage.input_tokens)} in / {fmtTokens(s.totalUsage.output_tokens)} out tokens
              {viewPly != null && <> · viewing ply {viewPly} <a href="#live" onClick={(e) => { e.preventDefault(); setViewPly(null); }}>back to live</a></>}
            </div>
            {err && <div className="error">Error: {err}</div>}
          </div>
        </div>

        <aside className="side">
          <section className="card">
            <h2>Analysis</h2>
            {shown ? (
              <>
                <div className="title">
                  <span>{shown.player}</span>
                  <span className="san">{shown.san}</span>
                </div>
                <div className="chips">
                  <span className="chip">{isMcts ? <>MCTS <b>{shown.simulations}</b> sims</> : <>Fast · <b>1</b> call</>}</span>
                  {isMcts && <span className="chip"><b>{shown.evaluations}</b> Jev calls · <b>{shown.cacheHits}</b> cached</span>}
                  {isMcts ? <span className="chip">Q <b>{fmtQ(shown.q)}</b></span> : <span className="chip">confidence <b>{shown.confidence.toFixed(2)}</b></span>}
                  <span className="chip"><b>{(shown.ms / 1000).toFixed(1)} s</b></span>
                  <span className="chip"><b>{fmtTokens(shown.usage.input_tokens)}</b> / <b>{fmtTokens(shown.usage.output_tokens)}</b> tokens</span>
                </div>
                <Candidates entry={shown} />
                {isMcts && (
                  <div className={`note ${shown.changedBySearch ? "changed" : ""}`}>
                    {shown.changedBySearch
                      ? <>Search overruled the prior: Jev's first instinct was <b className="mono">{shown.priorBest}</b>, the tree preferred <b className="mono">{shown.san}</b>.</>
                      : <>Search confirmed Jev's first instinct (<b className="mono">{shown.priorBest}</b>).</>}
                  </div>
                )}
                <div className="meter">
                  <div className="row"><span>Position score (mover's view, before the move)</span><b>{shown.evaluation.toFixed(2)} · {shown.evaluationLabel.split(":")[0]}</b></div>
                  <div className="bar"><i style={{ width: `${(shown.evaluation / 6) * 100}%` }} /></div>
                </div>
                <div className="meter">
                  <div className="row"><span>Tactically sharp (Noul)</span><b>{pct(shown.tactical)}</b></div>
                  <div className="bar alt"><i style={{ width: `${shown.tactical * 100}%` }} /></div>
                </div>
              </>
            ) : <p className="empty">No move yet. Press <b>One move</b> or <b>Autoplay</b>.</p>}
          </section>

          <section className="card">
            <h2>Players</h2>
            <div className="settings">
              <label>Decision mode
                <select value={s.settings.mode} onChange={(e) => updateSettings({ mode: e.target.value })} disabled={busy}>
                  <option value="mcts">MCTS · Jev as policy + value</option>
                  <option value="fast">Fast · one Jev call per move</option>
                </select>
              </label>
              <label>Simulations
                <input type="number" min="1" max="200" value={s.settings.simulations} disabled={busy || s.settings.mode !== "mcts"}
                  onChange={(e) => updateSettings({ simulations: Math.max(1, Math.min(200, +e.target.value || 1)) })} />
              </label>
              <label>Parallel
                <input type="number" min="1" max="16" value={s.settings.concurrency} disabled={busy || s.settings.mode !== "mcts"}
                  onChange={(e) => updateSettings({ concurrency: Math.max(1, Math.min(16, +e.target.value || 1)) })} />
              </label>
              <div className="hint">
                {s.settings.mode === "mcts"
                  ? `Each simulation is one Jev call (minus cache hits): about ${s.settings.simulations * 2.2 | 0}k tokens and ${(s.settings.simulations * 0.35 / s.settings.concurrency + 0.4).toFixed(1)} s per move.`
                  : "One Jev call per move: about 2–3k tokens and 0.4 s."}
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Moves</h2>
            {log.length === 0 ? <p className="empty">—</p> : (
              <div className="moves">
                {Array.from({ length: Math.ceil(log.length / 2) }, (_, i) => {
                  const w = log[i * 2], b = log[i * 2 + 1];
                  const cur = viewPly ?? log.length;
                  return [
                    <span key={`n${i}`} className="n">{i + 1}.</span>,
                    <span key={`w${i}`} className={`m ${cur === w.ply ? "cur" : ""} ${w.changedBySearch ? "changed" : ""}`} onClick={() => setViewPly(w.ply)}>{w.san}</span>,
                    b ? <span key={`b${i}`} className={`m ${cur === b.ply ? "cur" : ""} ${b.changedBySearch ? "changed" : ""}`} onClick={() => setViewPly(b.ply)}>{b.san}</span> : <span key={`b${i}`} />,
                  ];
                })}
              </div>
            )}
            <div className="legend">Click a move to review its position and analysis. † = search overruled Jev's first instinct.</div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function PlayerCard({ color, name, active, busy }) {
  return (
    <div className={`player ${active ? "active" : ""}`}>
      <div className="who">
        <span className="swatch" style={{ background: color === "w" ? "#f5f1e6" : "#1a1a1a" }} />
        <div>
          <div className="name">{name}</div>
          <div className="style">{STYLES[color]}</div>
        </div>
      </div>
      <div className="state">{busy ? <><span className="dot" /> thinking</> : active ? "to move" : ""}</div>
    </div>
  );
}

function Candidates({ entry }) {
  const isMcts = entry.mode === "mcts";
  const cands = entry.candidates ?? [];
  const max = Math.max(...cands.map((c) => (isMcts ? c.visits : c.prior)), 1e-9);
  return (
    <div className={`cands ${isMcts ? "mcts" : "fast"}`}>
      <span className="h">move</span><span className="h">{isMcts ? "visits" : "probability"}</span>
      {isMcts ? <><span className="h num">n</span><span className="h num">prior</span><span className="h num">q</span></> : <span className="h num">p</span>}
      {cands.map((c) => {
        const v = isMcts ? c.visits : c.prior;
        return [
          <span key={`s${c.san}`} className={`san ${c.san === entry.san ? "chosen" : ""}`}>{c.san}</span>,
          <div key={`b${c.san}`} className="bar"><i style={{ width: `${(v / max) * 100}%` }} /></div>,
          ...(isMcts
            ? [<span key={`n${c.san}`} className="num">{c.visits}</span>,
               <span key={`p${c.san}`} className="num">{pct(c.prior)}</span>,
               <span key={`q${c.san}`} className={`num ${c.q == null ? "" : c.q >= 0 ? "pos" : "neg"}`}>{fmtQ(c.q)}</span>]
            : [<span key={`p${c.san}`} className="num">{pct(c.prior)}</span>]),
        ];
      })}
    </div>
  );
}
