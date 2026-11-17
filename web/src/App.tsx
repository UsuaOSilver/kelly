import { useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, short, usd, type Entry, type State, type ToolResult } from "./api";
import { Ladder } from "./Ladder";

type Msg = { who: "you" | "kelly"; text: string; id: number };
const APPROVE_WORDS = /\b(approve|approved|approving|yes|yeah|yep|go ahead|do it|confirm|confirmed)\b/i;
const SUGGESTIONS = ["What's mispriced in Bitcoin?", "Size a bet", "Put $500 on it", "How's my budget?"];

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState({ elevenAgentId: "", hasElevenKey: false });
  const [voiceError, setVoiceError] = useState("");
  const lastUser = useRef("");
  const seq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const say = useCallback((who: Msg["who"], t: string) => setMsgs((m) => [...m.slice(-30), { who, text: t, id: ++seq.current }]), []);
  const refresh = useCallback(() => api.state().then(setState).catch(() => {}), []);

  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
    refresh();
    const es = new EventSource("/api/stream");
    let t: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(refresh, 80);
    };
    es.addEventListener("entry", bump);
    es.addEventListener("state", bump);
    const iv = setInterval(refresh, 8000);
    return () => {
      es.close();
      clearInterval(iv);
    };
  }, [refresh]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  // Every voice tool returns the server's own plain-language summary for the agent to speak from.
  const run = useCallback(
    async (p: Promise<ToolResult>) => {
      const r = await p;
      refresh();
      return r.say;
    },
    [refresh],
  );

  const conv = useConversation({
    clientTools: {
      find_mispricing: ({ asset }: { asset?: string }) => run(api.scan(asset)),
      size_bet: ({ usd: amount }: { usd?: number }) => run(api.propose(amount && amount > 0 ? amount : undefined)),
      // The model cannot approve its own request: this only runs if the human's last words were an approval.
      approve_request: () =>
        APPROVE_WORDS.test(lastUser.current)
          ? run(api.approve())
          : Promise.resolve("REFUSED by the app: the owner has not said they approve. Ask them clearly, and only call this after they say yes."),
      deny_request: () => run(api.deny()),
      get_status: () => run(api.status()),
      set_paused: ({ paused }: { paused: boolean }) => run(api.pause(paused)),
    },
    onMessage: (m: { message: string; source: "user" | "ai" }) => {
      if (m.source === "user") lastUser.current = m.message;
      say(m.source === "user" ? "you" : "kelly", m.message);
    },
    onError: (e: unknown) => setVoiceError(typeof e === "string" ? e : ((e as Error)?.message ?? "Voice connection failed")),
  });
  const live = conv.status === "connected";

  const toggleVoice = async () => {
    setVoiceError("");
    if (live || conv.status === "connecting") return conv.endSession();
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = await fetch("/api/eleven/signed-url");
      if (r.ok) conv.startSession({ signedUrl: (await r.json()).signed_url });
      else conv.startSession({ agentId: cfg.elevenAgentId });
    } catch (e) {
      setVoiceError((e as Error).message || "Microphone unavailable");
    }
  };

  const speak = async (t: string) => {
    if (cfg.hasElevenKey) {
      try {
        const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
        if (r.ok) return void new Audio(URL.createObjectURL(await r.blob())).play();
      } catch {
        /* fall through to the browser voice */
      }
    }
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(t.replace(/\$/g, "$ ")));
    }
  };

  const send = async (t: string) => {
    const q = t.trim();
    if (!q || busy) return;
    setText("");
    if (live) return conv.sendUserMessage(q); // the voice agent handles it and echoes via onMessage
    say("you", q);
    setBusy(true);
    const r = await api.chat(q);
    setBusy(false);
    say("kelly", r.say);
    refresh();
    void speak(r.say);
  };

  const act = async (p: Promise<ToolResult>) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    say("kelly", r.say);
    refresh();
    if (live) conv.sendContextualUpdate(`The owner used the on-screen button. Result: ${r.say}`);
    else void speak(r.say);
  };

  if (!state) return <div className="boot">Connecting to Kelly…</div>;
  const { vault, data, modes, pending, positions, analysis } = state;
  const capPct = Math.min(100, (vault.spentTodayUsd / Math.max(0.01, vault.dailyCapUsd)) * 100);
  const dataPct = Math.min(100, (data.spentUsd / Math.max(0.01, data.budgetUsd)) * 100);
  const real = modes.chain === "rpc";

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark">Kelly</span>
          <span className="tag">a prediction-market desk on an allowance</span>
        </div>
        <ul className="modes" aria-label="What is live and what is simulated">
          <Mode label="Vault" value={real ? vault.network : "simulated"} real={real} />
          <Mode label="Payments" value={modes.pay === "gateway" ? "Circle Gateway" : "local x402"} real={modes.pay === "gateway"} />
          <Mode label="Events" value={modes.events === "quicknode" ? "QuickNode Stream" : modes.events === "rpc-poll" ? "RPC poll" : "simulated"} real={modes.events !== "sim"} />
          <Mode label="Odds" value={modes.gemini === "live" ? "Gemini live" : "Gemini recording"} real={modes.gemini === "live"} />
          <Mode label="Trades" value={modes.trading === "paper" ? "paper" : "Gemini live"} real={modes.trading !== "paper"} />
        </ul>
      </header>

      <main className="grid">
        <section className="panel talk" aria-label="Talk to Kelly">
          <div className="voice">
            <button className={`mic ${live ? (conv.isSpeaking ? "speaking" : "listening") : ""}`} onClick={toggleVoice} disabled={!cfg.elevenAgentId} aria-pressed={live}>
              <MicIcon />
            </button>
            <div>
              <div className="voice-status">{!cfg.elevenAgentId ? "Voice is off" : live ? (conv.isSpeaking ? "Kelly is speaking" : "Listening…") : conv.status === "connecting" ? "Connecting…" : "Tap to talk"}</div>
              <div className="muted small">{!cfg.elevenAgentId ? "Add an ElevenLabs agent to speak. Typing works now." : "ElevenLabs voice agent"}</div>
              {voiceError && <div className="err small">{voiceError}</div>}
            </div>
          </div>

          <div className="thread" ref={scroller} aria-live="polite">
            {msgs.length === 0 && <p className="hint">Ask what's mispriced. Kelly buys the data it needs, a fraction of a cent at a time, and it can't spend past the limits you set.</p>}
            {msgs.map((m) => (
              <div key={m.id} className={`msg ${m.who}`}>
                {m.text}
              </div>
            ))}
            {busy && <div className="msg kelly thinking">Working…</div>}
          </div>

          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type to Kelly…" aria-label="Message Kelly" />
            <button type="submit" disabled={busy || !text.trim()}>
              Send
            </button>
          </form>
        </section>

        <section className="panel market" aria-label="Market">
          {analysis ? (
            <>
              <div className="eyebrow">Gemini Prediction Markets · {analysis.event}</div>
              <h1>{analysis.title}</h1>
              <dl className="facts">
                <Fact k="Index now" v={`$${analysis.spot.toLocaleString("en-US", { maximumFractionDigits: analysis.spot < 10 ? 4 : 0 })}`} />
                <Fact k="Volatility" v={`${(analysis.sigma * 100).toFixed(0)}%/yr`} />
                <Fact k="Settles in" v={analysis.hoursToExpiry < 48 ? `${analysis.hoursToExpiry.toFixed(1)} h` : `${(analysis.hoursToExpiry / 24).toFixed(0)} days`} />
                <Fact k="Best edge" v={analysis.best ? `${(analysis.best.edge! * 100).toFixed(0)} pts` : "none"} strong={!!analysis.best} />
              </dl>
              <Ladder a={analysis} pick={state.pick} />
              {analysis.suspect > 0 && <p className="muted small">{analysis.suspect} strike(s) looked more than 15 points off. Kelly assumes its own model is wrong there and ignores them.</p>}
            </>
          ) : (
            <div className="empty">
              <div className="eyebrow">Gemini Prediction Markets</div>
              <h1>No market open yet</h1>
              <p className="muted">Ask about Bitcoin, Ether, Solana or XRP and the odds ladder appears here next to Kelly's own estimate.</p>
            </div>
          )}

          {positions.length > 0 && (
            <div className="positions">
              <h2>Positions</h2>
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th className="n">Size</th>
                    <th className="n">Paid</th>
                    <th className="n">Now</th>
                    <th className="n">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <b className={p.side}>{p.side.toUpperCase()}</b> {p.label}
                        <span className="muted small"> · {p.mode === "paper" ? "paper" : "live"}</span>
                      </td>
                      <td className="n">{p.contracts}</td>
                      <td className="n">{p.avgPrice.toFixed(2)}</td>
                      <td className="n">{p.markPrice?.toFixed(2) ?? "–"}</td>
                      <td className={`n ${p.pnlUsd != null && p.pnlUsd < 0 ? "neg" : "pos"}`}>{p.pnlUsd != null ? usd(p.pnlUsd, 2) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="side">
          {pending.map((p) => (
            <section key={p.requestId} className="panel approval" aria-label="Approval needed">
              <div className="eyebrow">Needs your approval · request #{p.requestId}</div>
              <div className="ask">{usd(p.amountUsd, 2)}</div>
              {p.intent && (
                <p>
                  <b className={p.intent.side}>{p.intent.side.toUpperCase()}</b> {p.intent.label}
                  <br />
                  <span className="muted small">
                    pays {(p.intent.price * 100).toFixed(0)}¢ · model {(p.intent.modelP * 100).toFixed(0)}% · edge {(p.intent.edge * 100).toFixed(0)} pts
                  </span>
                </p>
              )}
              <p className="muted small">Over your {usd(vault.autoApproveUsd, 2)} auto-approve limit. The money is still in the vault.</p>
              <div className="row">
                <button className="primary" onClick={() => act(api.approve(p.requestId))} disabled={busy}>
                  Approve
                </button>
                <button onClick={() => act(api.deny(p.requestId))} disabled={busy}>
                  Deny
                </button>
              </div>
            </section>
          ))}

          <section className="panel allowance" aria-label="Allowance">
            <div className="eyebrow">Vault {real ? <Addr a={vault.address} explorer={modes.explorer} /> : "· simulated"}</div>
            <div className="balance">
              {usd(vault.balanceUsd, 2)} <span>USDC</span>
            </div>
            <Meter label="Spent today" value={`${usd(vault.spentTodayUsd, 2)} of ${usd(vault.dailyCapUsd, 2)}`} pct={capPct} />
            <Meter label={`Data bought · ${data.calls} call${data.calls === 1 ? "" : "s"}`} value={`${usd(data.spentUsd)} of ${usd(data.budgetUsd, 2)}`} pct={dataPct} />
            <dl className="rules">
              <Fact k="Kelly can spend alone" v={`up to ${usd(vault.autoApproveUsd, 2)}`} />
              <Fact k="Above that" v="you approve" />
              <Fact k="Per data call" v={`max ${usd(data.maxPerCallUsd)}`} />
            </dl>
            <button className={vault.paused ? "primary wide" : "danger wide"} onClick={() => act(api.pause(!vault.paused))} disabled={busy}>
              {vault.paused ? "Resume Kelly" : "Pause Kelly"}
            </button>
          </section>

          <section className="panel ledger" aria-label="Activity">
            <div className="eyebrow">Activity</div>
            <ol>
              {[...state.ledger].reverse().slice(0, 40).map((e) => (
                <Line key={e.id} e={e} explorer={real ? modes.explorer : ""} />
              ))}
              {state.ledger.length === 0 && <li className="muted small">Nothing yet.</li>}
            </ol>
          </section>
        </aside>
      </main>
    </div>
  );
}

function Mode({ label, value, real }: { label: string; value: string; real: boolean }) {
  return (
    <li className={real ? "real" : "sim"}>
      <span>{label}</span> {value}
    </li>
  );
}
function Fact({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={strong ? "strong" : ""}>{v}</dd>
    </div>
  );
}
function Meter({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${pct}%` }} className={pct >= 100 ? "full" : ""} />
      </div>
    </div>
  );
}
function Addr({ a, explorer }: { a: string; explorer: string }) {
  return explorer ? (
    <a href={`${explorer}/address/${a}`} target="_blank" rel="noreferrer">
      {short(a)}
    </a>
  ) : (
    <span>{short(a)}</span>
  );
}

const KIND: Record<string, string> = { data_payment: "paid", blocked: "blocked", vault_spent: "released", vault_requested: "asked", vault_denied: "denied", vault_paused: "vault", order: "order", step: "", info: "note" };
function Line({ e, explorer }: { e: Entry; explorer: string }) {
  const onchain = explorer && e.tx && e.kind.startsWith("vault");
  return (
    <li className={`line ${e.kind}`}>
      <div className="line-main">
        {KIND[e.kind] && <span className="badge">{KIND[e.kind]}</span>}
        <span className="line-title">{e.title}</span>
        {e.amountUsd != null && e.kind === "data_payment" && <span className="amt">{usd(e.amountUsd)}</span>}
      </div>
      {(e.detail || e.kind !== "step") && (
        <div className="line-sub">
          {e.detail}
          {e.detail && e.kind !== "step" ? " · " : ""}
          {e.kind !== "step" && (onchain ? <a href={`${explorer}/tx/${e.tx}`} target="_blank" rel="noreferrer">via {e.source} ↗</a> : <span>via {e.source}</span>)}
        </div>
      )}
    </li>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}
