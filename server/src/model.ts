// Fair-value model and bet sizing. Deliberately simple and fully inspectable:
// a driftless lognormal on Gemini's own reference index, with volatility measured
// from that index's recent candles. It is a sanity check on the market, not alpha.
import type { Book, Contract, GEvent, Kline } from "./gemini.ts";
import { num } from "./gemini.ts";

const YEAR_MS = 365 * 24 * 3600_000;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Annualised realised volatility from close-to-close log returns. Klines may arrive in either order. */
export function realizedVol(klines: Kline[]): { sigma: number; spot: number; n: number; intervalMs: number } {
  const rows = [...klines].sort((a, b) => a[0] - b[0]);
  if (rows.length < 12) throw new Error("Not enough candles to estimate volatility");
  const intervalMs = rows[1][0] - rows[0][0];
  const rets: number[] = [];
  for (let i = 1; i < rows.length; i++) rets.push(Math.log(rows[i][4] / rows[i - 1][4]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const sigma = Math.sqrt(variance * (YEAR_MS / intervalMs));
  return { sigma, spot: rows[rows.length - 1][4], n: rets.length, intervalMs };
}

/** P(S_T >= K) for a driftless lognormal. */
export function probAbove(spot: number, strike: number, sigma: number, msToExpiry: number): number {
  if (msToExpiry <= 0) return spot >= strike ? 1 : 0;
  const T = msToExpiry / YEAR_MS;
  const sd = sigma * Math.sqrt(T);
  if (sd === 0) return spot >= strike ? 1 : 0;
  const d2 = (Math.log(spot / strike) - 0.5 * sd * sd) / sd;
  return normCdf(d2);
}

export type Side = "yes" | "no";
export type Row = {
  symbol: string;
  label: string;
  strike: number;
  bid: number | null; // best bid for YES
  ask: number | null; // best ask for YES
  mid: number | null;
  model: number; // model P(YES)
  /** Best executable edge after crossing the spread, and which side has it. */
  side: Side | null;
  price: number | null; // what you pay per contract on that side
  edge: number | null; // model win probability minus price paid
};
export type Analysis = {
  event: string;
  title: string;
  index: string;
  spot: number;
  sigma: number;
  hoursToExpiry: number;
  expiry: string;
  rows: Row[];
  best: Row | null;
  /** Rows whose apparent edge was too large to believe. */
  suspect: number;
};

/**
 * @param liveSpot current index level from a real-time source. Candle closes trail by minutes, and a stale
 *                 spot on a market that settles within hours manufactures edges that are not there.
 * @param maxEdge  anything "mispriced" by more than this is treated as the model being wrong, not the market.
 */
export function analyzeEvent(ev: GEvent, klines: Kline[], now: number, minEdge: number, liveSpot: number | null = null, maxEdge = 0.15): Analysis {
  const { sigma, spot: candleSpot } = realizedVol(klines);
  const spot = liveSpot ?? candleSpot;
  const expiryMs = Date.parse(ev.expiryDate);
  const rows: Row[] = [];
  for (const c of ev.contracts) {
    if (c.strike?.type !== "above" || (c.marketState && c.marketState !== "open")) continue;
    const strike = Number(c.strike.value);
    const bid = num(c.prices?.bestBid);
    const ask = num(c.prices?.bestAsk);
    const model = probAbove(spot, strike, sigma, expiryMs - now);
    // Buying YES costs the ask. Buying NO costs (1 - bid). Either side wins $1.
    const edgeYes = ask != null ? model - ask : null;
    const edgeNo = bid != null ? 1 - model - (1 - bid) : null;
    let side: Side | null = null;
    let price: number | null = null;
    let edge: number | null = null;
    if (edgeYes != null && (edgeNo == null || edgeYes >= edgeNo)) [side, price, edge] = ["yes", ask!, edgeYes];
    else if (edgeNo != null) [side, price, edge] = ["no", 1 - bid!, edgeNo];
    rows.push({
      symbol: c.instrumentSymbol,
      label: c.label,
      strike,
      bid,
      ask,
      mid: bid != null && ask != null ? (bid + ask) / 2 : null,
      model,
      side,
      price: price == null ? null : round2(price),
      edge,
    });
  }
  rows.sort((a, b) => a.strike - b.strike);
  // Ignore lottery tickets and near-certainties: tiny prices make edge/price ratios meaningless.
  const tradable = rows.filter((r) => r.edge != null && r.price != null && r.price >= 0.1 && r.price <= 0.9 && r.edge >= minEdge && r.edge <= maxEdge);
  const best = tradable.sort((a, b) => b.edge! - a.edge!)[0] ?? null;
  return {
    event: ev.ticker,
    title: ev.title,
    index: ev.sourceDetails?.index ?? "",
    spot,
    sigma,
    hoursToExpiry: (expiryMs - now) / 3600_000,
    expiry: ev.expiryDate,
    rows,
    best,
    suspect: rows.filter((r) => r.edge != null && r.edge > maxEdge).length,
  };
}

/** Kelly fraction of bankroll for a binary contract bought at `price` that pays 1 with probability p. */
export function kellyFraction(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return Math.max(0, (p - price) / (1 - price));
}

export type Fill = { contracts: number; cost: number; avgPrice: number; worstPrice: number; levels: number; exhausted: boolean };

/**
 * Walk the order book to spend up to `usd` on one side, never paying above `limitPrice`.
 * Books are quoted in YES space: buying YES lifts asks; buying NO hits bids at (1 - bid).
 */
export function walkBook(book: Book, side: Side, usd: number, limitPrice: number): Fill {
  const levels =
    side === "yes"
      ? book.asks.map((l) => ({ price: Number(l.price), qty: Number(l.amount) })).sort((a, b) => a.price - b.price)
      : book.bids.map((l) => ({ price: round2(1 - Number(l.price)), qty: Number(l.amount) })).sort((a, b) => a.price - b.price);
  let left = usd;
  let contracts = 0;
  let cost = 0;
  let worst = 0;
  let used = 0;
  for (const l of levels) {
    if (l.price > limitPrice + 1e-9 || left <= 1e-9) break;
    const take = Math.min(l.qty, Math.floor((left / l.price) * 100) / 100);
    if (take <= 0) break;
    contracts += take;
    cost += take * l.price;
    left -= take * l.price;
    worst = l.price;
    used++;
  }
  return {
    contracts: round2(contracts),
    cost: round2(cost),
    avgPrice: contracts ? cost / contracts : 0,
    worstPrice: worst,
    levels: used,
    exhausted: cost < usd * 0.98,
  };
}

export type Sizing = {
  kellyFull: number;
  fraction: number;
  bankroll: number;
  raw: number; // fraction * kelly * bankroll
  stake: number; // after every cap
  cappedBy: string[];
};

export function sizeBet(opts: {
  p: number; // win probability of the side being bought
  price: number;
  bankroll: number;
  fraction: number;
  requested?: number; // user asked for a specific amount
  remainingToday: number;
  liquidityUsd: number;
}): Sizing {
  const kellyFull = kellyFraction(opts.p, opts.price);
  const raw = kellyFull * opts.fraction * opts.bankroll;
  const cappedBy: string[] = [];
  let stake = opts.requested ?? raw;
  if (opts.requested == null && stake > opts.remainingToday) {
    stake = opts.remainingToday;
    cappedBy.push("daily cap");
  }
  if (stake > opts.liquidityUsd) {
    stake = opts.liquidityUsd;
    cappedBy.push("book depth");
  }
  return { kellyFull, fraction: opts.fraction, bankroll: opts.bankroll, raw: round2(raw), stake: Math.floor(stake * 100) / 100, cappedBy };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
