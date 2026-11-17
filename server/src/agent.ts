// Kelly's decision loop. Every public function here is a tool the voice agent can call.
//
//   scan     discover markets (free) → buy fair-value signal (paid) → rank by edge
//   propose  buy liquidity + tape signals (paid) → size with fractional Kelly → ask the vault for money
//   approve  the human releases a request that was above the auto-approve limit
//   (event)  the vault's Spent event — not the agent's own optimism — is what triggers the order
//
// The agent key can only call vault.spend(). It cannot approve, change policy, or withdraw.
import { cfg, usd } from "./config.ts";
import { listEvents, marketNow, sourceState } from "./gemini.ts";
import { bus, log, step } from "./ledger.ts";
import { sizeBet, type Analysis, type Row, type Side } from "./model.ts";
import { agentAccount, dataPolicy, depositToGateway, gatewayBalanceUsd, payFor, PolicyBlock } from "./pay.ts";
import { buildSellers, type Seller } from "./sellers.ts";
import { memoOf, RpcVault, SimVault, VaultRevert, type Vault, type VaultEvent } from "./vault.ts";
import { markPositions, placeOrder, positions } from "./venue.ts";

export type Intent = {
  id: string;
  event: string;
  title: string;
  symbol: string;
  label: string;
  side: Side;
  price: number;
  limitPrice: number;
  modelP: number;
  edge: number;
  stakeUsd: number;
  status: "submitted" | "awaiting_approval" | "funded" | "filled" | "denied" | "blocked";
  requestId?: string;
  reason?: string;
  ts: number;
};
export type Pending = { requestId: string; to: string; amountUsd: number; intentId?: string; ts: number; tx: string; source: string };

export let vault: Vault;
export let sellers: Seller[] = [];
export let eventSource: "sim" | "rpc-poll" | "quicknode" = "sim";

const session = {
  analysis: null as Analysis | null,
  pick: null as { analysis: Analysis; row: Row } | null,
  intents: new Map<string, Intent>(),
  byMemo: new Map<string, string>(), // memo → intentId or "topup"
  pending: new Map<string, Pending>(),
  seen: new Set<string>(),
  n: 0,
};

const ASSETS: Record<string, string> = { bitcoin: "BTC", btc: "BTC", ethereum: "ETH", ether: "ETH", eth: "ETH", solana: "SOL", sol: "SOL", xrp: "XRP", ripple: "XRP", zcash: "ZEC", zec: "ZEC", hype: "HYPE", hyperliquid: "HYPE" };
const NAMES: Record<string, string> = { BTC: "Bitcoin", ETH: "Ether", SOL: "Solana", XRP: "XRP", ZEC: "Zcash", HYPE: "Hype" };
export const assetOf = (text: string) => Object.entries(ASSETS).find(([k]) => new RegExp(`\\b${k}\\b`, "i").test(text))?.[1];

const pct = (p: number) => `${Math.round(p * 100)}%`;
const cents = (p: number) => `${Math.round(p * 100)} cents`;
const pts = (e: number) => `${(e * 100).toFixed(0)} point${Math.abs(e * 100) >= 1.5 ? "s" : ""}`;
const when = (iso: string) => {
  const far = Date.parse(iso) - marketNow() > 6 * 86400_000;
  return new Date(iso).toLocaleString("en-US", { ...(far ? { month: "short", day: "numeric" } : { weekday: "long" }), hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" });
};
const describe = (a: Analysis, r: Row) => `${NAMES[a.event.match(/^[A-Z]+/)?.[0] ?? ""] ?? a.title} at ${r.label} by ${when(a.expiry)}`;

// ─────────────────────────────── wiring ───────────────────────────────

export async function init() {
  if (cfg.chainMode === "rpc") {
    const v = new RpcVault();
    vault = v;
    eventSource = cfg.eventSource === "quicknode" || (cfg.eventSource === "auto" && cfg.quicknodeToken) ? "quicknode" : "rpc-poll";
    if (eventSource === "rpc-poll") setInterval(() => v.poll("rpc-poll").then((es) => es.forEach(onVaultEvent)).catch(() => {}), 1500);
  } else {
    vault = new SimVault(agentAccount.address, onVaultEvent);
    eventSource = "sim";
  }
  sellers = buildSellers(cfg.sellerAddresses);
  for (const s of sellers) dataPolicy.allowedSellers.add(s.address.toLowerCase());
}

const waiters = new Map<string, (e: VaultEvent) => void>();
/** Events can land before anyone is waiting (a fast chain, or the sim), so the latest per memo is kept. */
const arrived = new Map<string, VaultEvent>();
function waitForMemo(memo: string, ms: number): Promise<VaultEvent | null> {
  const hit = arrived.get(memo);
  if (hit) {
    arrived.delete(memo);
    return Promise.resolve(hit);
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiters.delete(memo);
      resolve(null);
    }, ms);
    waiters.set(memo, (e) => {
      clearTimeout(t);
      waiters.delete(memo);
      resolve(e);
    });
  });
}

/** If the Stream is the event source and it is slow, catch up once over RPC and say so in the ledger. */
async function awaitEvent(memo: string, ms = 20_000): Promise<VaultEvent | null> {
  const first = await waitForMemo(memo, eventSource === "quicknode" ? 12_000 : ms);
  if (first || eventSource !== "quicknode" || !vault.poll) return first;
  const p = waitForMemo(memo, 4000);
  (await vault.poll("rpc-fallback")).forEach(onVaultEvent);
  return p;
}

/** Single entry point for vault events from any source (sim, RPC poll, QuickNode Stream). Idempotent. */
export function onVaultEvent(e: VaultEvent) {
  const key = `${e.tx}:${e.logIndex}`;
  if (session.seen.has(key)) return;
  session.seen.add(key);
  const intentId = e.memo ? session.byMemo.get(e.memo) : undefined;
  const intent = intentId ? session.intents.get(intentId) : undefined;

  if (e.name === "SpendRequested") {
    session.pending.set(e.requestId!, { requestId: e.requestId!, to: e.to!, amountUsd: e.amountUsd!, intentId, ts: Date.now(), tx: e.tx, source: e.source });
    if (intent) Object.assign(intent, { status: "awaiting_approval", requestId: e.requestId });
    log({ kind: "vault_requested", title: `Approval needed: ${usd(e.amountUsd!)}`, detail: intent ? `${intent.side.toUpperCase()} ${intent.label}` : undefined, amountUsd: e.amountUsd, to: e.to, tx: e.tx, source: e.source, intentId, requestId: e.requestId });
  } else if (e.name === "Spent") {
    if (e.requestId) session.pending.delete(e.requestId);
    const topup = e.to?.toLowerCase() === vault.agent.toLowerCase();
    log({ kind: "vault_spent", title: topup ? `Vault released ${usd(e.amountUsd!)} data budget` : `Vault released ${usd(e.amountUsd!)} to trading account`, detail: e.ownerApproved ? "approved by owner" : "inside auto-approve limit", amountUsd: e.amountUsd, to: e.to, tx: e.tx, source: e.source, intentId, requestId: e.requestId });
    if (intent && intent.status !== "filled") {
      intent.status = "funded";
      void execute(intent);
    }
  } else if (e.name === "SpendDenied") {
    const p = session.pending.get(e.requestId!);
    session.pending.delete(e.requestId!);
    const it = p?.intentId ? session.intents.get(p.intentId) : undefined;
    if (it) it.status = "denied";
    log({ kind: "vault_denied", title: "Owner denied the request", tx: e.tx, source: e.source, requestId: e.requestId, intentId: p?.intentId });
  } else if (e.name === "PausedSet") {
    log({ kind: "vault_paused", title: e.paused ? "Vault paused: agent cannot spend" : "Vault resumed", tx: e.tx, source: e.source });
  }
  if (e.memo) {
    const w = waiters.get(e.memo);
    if (w) w(e);
    else arrived.set(e.memo, e);
  }
  bus.emit("state");
}

async function execute(intent: Intent) {
  try {
    const pos = await placeOrder({ intentId: intent.id, event: intent.event, symbol: intent.symbol, label: intent.label, side: intent.side, usd: intent.stakeUsd, limitPrice: intent.limitPrice, modelP: intent.modelP });
    intent.status = "filled";
    log({
      kind: "order",
      title: `Bought ${pos.contracts} ${intent.side.toUpperCase()} @ ${pos.avgPrice.toFixed(3)}`,
      detail: `${intent.label} · ${pos.mode === "paper" ? "paper fill against the live Gemini book" : `Gemini order ${pos.orderId}`}`,
      amountUsd: pos.costUsd,
      source: pos.mode === "paper" ? "paper" : "gemini",
      intentId: intent.id,
    });
  } catch (e) {
    intent.status = "blocked";
    intent.reason = (e as Error).message;
    log({ kind: "blocked", title: "Order failed", detail: intent.reason, source: "gemini", intentId: intent.id });
  }
  bus.emit("state");
}

async function ensureDataFunds() {
  if ((await gatewayBalanceUsd()) >= 0.05) return;
  step("Data balance is low", `Asking the vault for ${usd(cfg.dataTopUpUsd)} to buy signals`);
  const memo = memoOf(`data-topup-${++session.n}-${Date.now()}`);
  session.byMemo.set(memo, "topup");
  await vault.spend(vault.agent, cfg.dataTopUpUsd, memo);
  const ev = await awaitEvent(memo);
  if (!ev || ev.name !== "Spent") throw new Error("The vault did not release the data budget");
  await depositToGateway(cfg.dataTopUpUsd);
}

// ─────────────────────────────── tools ───────────────────────────────

export type ToolResult = { ok: boolean; say: string; data?: unknown };

const guard = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof VaultRevert) {
      log({ kind: "blocked", title: `Vault refused: ${e.errorName}`, detail: e.human, source: vault.mode === "sim" ? "sim" : "contract" });
      return { ok: false, say: `The vault refused: ${e.human}.` };
    }
    if (e instanceof PolicyBlock) return { ok: false, say: `I stopped myself. ${e.message}` };
    log({ kind: "info", title: "Error", detail: (e as Error).message, source: "agent" });
    return { ok: false, say: `Something went wrong: ${(e as Error).message}` };
  }
};

export const scan = (assetIn?: string) =>
  guard(async () => {
    const asset = (assetIn && (ASSETS[assetIn.toLowerCase()] ?? assetIn.toUpperCase())) || "BTC";
    step(`Looking for ${asset} markets on Gemini`, "Free discovery call");
    const events = (await listEvents({ category: "Crypto" }))
      .filter((e) => e.template === "prices-ladder" && (e.series ?? e.ticker).startsWith(asset) && Date.parse(e.expiryDate) - marketNow() > 45 * 60_000)
      .sort((a, b) => Date.parse(a.expiryDate) - Date.parse(b.expiryDate))
      .slice(0, 3);
    if (!events.length) return { ok: false, say: `I can't find an open ${NAMES[asset] ?? asset} price market on Gemini right now.` };

    await ensureDataFunds();
    const sigma = sellers[0];
    const analyses: Analysis[] = [];
    for (const e of events) {
      const r = await payFor<Analysis>(`${cfg.publicUrl}${sigma.path}?event=${encodeURIComponent(e.ticker)}`, `Sigma · fair value · ${e.title}`);
      analyses.push(r.data);
    }
    const ranked = analyses.filter((a) => a.best).sort((a, b) => b.best!.edge! - a.best!.edge!);
    const top = ranked[0] ?? analyses[0];
    session.analysis = top;
    session.pick = top.best ? { analysis: top, row: top.best } : null;
    const spent = analyses.length * sigma.priceUsd;

    if (!top.best) {
      step("No edge found", `Nothing beats the ${pts(cfg.minEdge)} minimum after the spread`);
      return { ok: true, say: `I checked ${analyses.length} ${NAMES[asset] ?? asset} market${analyses.length > 1 ? "s" : ""} for ${usd(spent)}. Nothing is mispriced by more than ${pts(cfg.minEdge)} after the spread, so I'd sit this one out.`, data: top };
    }
    const r = top.best;
    const p = r.side === "yes" ? r.model : 1 - r.model;
    step(`Best edge: ${r.side!.toUpperCase()} ${r.label}`, `market ${cents(r.price!)} · model ${pct(p)} · edge ${pts(r.edge!)}`);
    return {
      ok: true,
      say: `${describe(top, r)}. The market charges ${cents(r.price!)} for ${r.side === "yes" ? "yes" : "no"}; my model says ${pct(p)}. That's a ${pts(r.edge!).replace("points", "point").replace(" point", "-point")} edge. That answer cost ${usd(spent)}. Want me to size a bet?`,
      data: top,
    };
  });

export const propose = (args: { usd?: number; symbol?: string; side?: Side } = {}) =>
  guard(async () => {
    if (!session.analysis) {
      const s = await scan("BTC");
      if (!s.ok) return s;
    }
    const a = session.pick?.analysis ?? session.analysis!;
    const row = args.symbol ? a.rows.find((r) => r.symbol === args.symbol) : session.pick?.row;
    if (!row || row.price == null || row.edge == null) return { ok: false, say: "I don't have a market with an edge picked out. Ask me what's mispriced first." };
    const side = args.side ?? row.side!;
    const price = side === "yes" ? row.ask! : 1 - row.bid!;
    const p = side === "yes" ? row.model : 1 - row.model;
    const edge = p - price;
    if (edge < cfg.minEdge) {
      log({ kind: "blocked", title: "No bet: edge too small", detail: `${pts(edge)} is under the ${pts(cfg.minEdge)} minimum`, source: "policy" });
      return { ok: false, say: `I won't take that. The edge is ${pts(edge)}, under my ${pts(cfg.minEdge)} minimum.` };
    }

    const st = await vault.state();
    const id = `intent_${++session.n}`;
    const memo = memoOf(`${id}:${row.symbol}:${Date.now()}`);
    const limitPrice = Math.min(0.99, Math.round((price + 0.02) * 100) / 100);
    const mk = (stakeUsd: number): Intent => ({ id, event: a.event, title: a.title, symbol: row.symbol, label: row.label, side, price, limitPrice, modelP: p, edge, stakeUsd, status: "submitted", ts: Date.now() });

    // An explicit amount over what the vault can release today goes straight to the contract, which is the authority.
    if (args.usd != null && args.usd > st.remainingTodayUsd) {
      step(`Asking the vault for ${usd(args.usd)}`, "This is more than today's remaining allowance");
      const intent = mk(args.usd);
      intent.status = "blocked";
      session.intents.set(id, intent);
      await vault.spend(vault.venue, args.usd, memo); // reverts → handled by guard()
    }

    await ensureDataFunds();
    const [depth, tapeS] = [sellers[1], sellers[2]];
    const want = args.usd ?? Math.min(st.remainingTodayUsd, st.balanceUsd);
    const liq = await payFor<any>(`${cfg.publicUrl}${depth.path}?symbol=${row.symbol}&side=${side}&usd=${want.toFixed(2)}&limit=${limitPrice}`, `Depth · fill check · ${row.label}`);
    const tp = await payFor<any>(`${cfg.publicUrl}${tapeS.path}?event=${a.event}&symbol=${row.symbol}`, `Tape · odds history · ${row.label}`);

    const sizing = sizeBet({ p, price, bankroll: st.balanceUsd, fraction: cfg.kellyFraction, requested: args.usd, remainingToday: st.remainingTodayUsd, liquidityUsd: liq.data.availableUsd });
    step(
      `Sized the bet: ${usd(sizing.stake)}`,
      `Kelly ${(sizing.kellyFull * 100).toFixed(1)}% × ${cfg.kellyFraction} × ${usd(st.balanceUsd)} bankroll = ${usd(sizing.raw)}${sizing.cappedBy.length ? ` · capped by ${sizing.cappedBy.join(", ")}` : ""} · index ${tp.data.indexChange1hPct >= 0 ? "+" : ""}${tp.data.indexChange1hPct.toFixed(2)}% in the last hour`,
      id,
    );
    if (sizing.stake < 1) return { ok: false, say: `The right size here is under a dollar${sizing.cappedBy.includes("book depth") ? " because the order book is thin" : ""}, so it isn't worth placing.` };

    const intent = mk(sizing.stake);
    session.intents.set(id, intent);
    session.byMemo.set(memo, id);
    step(`Asking the vault for ${usd(intent.stakeUsd)}`, `to the trading account · auto-approve limit is ${usd(st.autoApproveUsd)}`, id);
    await vault.spend(vault.venue, intent.stakeUsd, memo);
    const ev = await awaitEvent(memo);
    const sizeWhy = args.usd != null ? `You asked for ${usd(args.usd)}${sizing.cappedBy.length ? `, and ${sizing.cappedBy.join(" and ")} cut it to ${usd(sizing.stake)}` : ""}.` : `Half-Kelly on your ${usd(st.balanceUsd)} bankroll is ${usd(sizing.raw)}${sizing.cappedBy.length ? `, cut to ${usd(sizing.stake)} by ${sizing.cappedBy.join(" and ")}` : ""}.`;

    if (ev?.name === "SpendRequested")
      return { ok: true, say: `${sizeWhy} That's over your ${usd(st.autoApproveUsd)} auto-approve limit, so I've asked the vault and it's waiting on you. Do you approve ${usd(intent.stakeUsd)} on ${side} for ${row.label}?`, data: { intent, awaitingApproval: true } };
    if (ev?.name === "Spent") {
      await settle(intent);
      return { ok: true, say: `${sizeWhy} It's inside your auto-approve limit, so it's done. ${fillLine(intent)}`, data: { intent } };
    }
    return { ok: true, say: `${sizeWhy} I've sent the request to the vault and I'm waiting for it to confirm onchain.`, data: { intent } };
  });

const settle = async (intent: Intent) => {
  for (let i = 0; i < 40 && intent.status === "funded"; i++) await new Promise((r) => setTimeout(r, 100));
};
function fillLine(intent: Intent) {
  const pos = positions.find((p) => p.intentId === intent.id);
  if (!pos) return intent.reason ? `The order failed: ${intent.reason}.` : "The order is going in now.";
  if (pos.contracts === 0) return "The book moved and nothing filled inside my limit. The money is sitting in the trading account.";
  return `Bought ${pos.contracts} ${intent.side} contracts at ${cents(pos.avgPrice)}${pos.mode === "paper" ? ", as a paper fill against the live book" : ""}. If it lands, that pays ${usd(pos.contracts)}.`;
}

const latestPending = () => [...session.pending.values()].sort((a, b) => b.ts - a.ts)[0];

export const approve = (requestId?: string) =>
  guard(async () => {
    const p = requestId ? session.pending.get(requestId) : latestPending();
    if (!p) return { ok: false, say: "There's nothing waiting for approval." };
    const intent = p.intentId ? session.intents.get(p.intentId) : undefined;
    const memo = [...session.byMemo.entries()].find(([, v]) => v === p.intentId)?.[0];
    if (memo) arrived.delete(memo);
    const w = memo ? awaitEvent(memo) : Promise.resolve(null);
    await vault.approve(p.requestId);
    await w;
    if (intent) await settle(intent);
    return { ok: true, say: `Approved. The vault released ${usd(p.amountUsd)}. ${intent ? fillLine(intent) : ""}`.trim(), data: { intent } };
  });

export const deny = (requestId?: string) =>
  guard(async () => {
    const p = requestId ? session.pending.get(requestId) : latestPending();
    if (!p) return { ok: false, say: "There's nothing waiting for approval." };
    await vault.deny(p.requestId);
    return { ok: true, say: "Denied. Nothing left the vault." };
  });

export const pause = (on: boolean) =>
  guard(async () => {
    await vault.setPaused(on);
    return { ok: true, say: on ? "Paused. I can't spend anything until you resume me." : "Resumed." };
  });

export async function snapshot() {
  const [v, gateway, pos] = await Promise.all([vault.state(), gatewayBalanceUsd().catch(() => 0), markPositions()]);
  return {
    vault: v,
    agent: vault.agent,
    venue: vault.venue,
    data: { gatewayBalanceUsd: gateway, spentUsd: dataPolicy.spentUsd, calls: dataPolicy.calls, budgetUsd: cfg.dataBudgetPerSessionUsd, maxPerCallUsd: cfg.maxPricePerCallUsd },
    pending: [...session.pending.values()].map((p) => ({ ...p, intent: p.intentId ? session.intents.get(p.intentId) : undefined })),
    positions: pos,
    analysis: session.analysis,
    pick: session.pick?.row.symbol ?? null,
    sellers,
    modes: { chain: cfg.chainMode, pay: cfg.payMode, events: eventSource, gemini: sourceState.last, geminiFixtureAt: sourceState.fixtureRecordedAt, trading: cfg.liveTrading && cfg.geminiKey ? "gemini-live" : "paper", explorer: cfg.explorer },
  };
}

export const status = () =>
  guard(async () => {
    const s = await snapshot();
    const open = s.positions.length;
    const pnl = s.positions.reduce((a, p) => a + (p.pnlUsd ?? 0), 0);
    return {
      ok: true,
      say: `The vault holds ${usd(s.vault.balanceUsd)}. I've used ${usd(s.vault.spentTodayUsd)} of today's ${usd(s.vault.dailyCapUsd)} cap, and ${usd(s.data.spentUsd)} on ${s.data.calls} data calls. ${open ? `${open} open position${open > 1 ? "s" : ""}, ${pnl >= 0 ? "up" : "down"} ${usd(Math.abs(pnl))} at current bids.` : "No open positions."}${s.pending.length ? ` One request is waiting for your approval.` : ""}${s.vault.paused ? " I'm paused." : ""}`,
      data: s,
    };
  });

/** Typed-console fallback: a deliberately dumb keyword router, so the demo works with no voice and no LLM. */
export async function chat(text: string): Promise<ToolResult> {
  const t = text.toLowerCase();
  const amount = t.match(/\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:dollars|bucks|usdc)/);
  if (/\b(approve|approved|yes|go ahead|do it)\b/.test(t) && session.pending.size) return approve();
  if (/\b(deny|denied|reject|cancel|no)\b/.test(t) && session.pending.size) return deny();
  if (/\b(resume|unpause)\b/.test(t)) return pause(false);
  if (/\b(pause|stop|kill|freeze)\b/.test(t)) return pause(true);
  if (/\b(budget|balance|status|positions?|how much|spent)\b/.test(t)) return status();
  if (amount && /\b(put|bet|buy|stake|risk|on it)\b/.test(t)) return propose({ usd: Number(amount[1] ?? amount[2]) });
  if (/\b(bet|buy|size|trade|take it|place)\b/.test(t)) return propose();
  return scan(assetOf(t));
}
