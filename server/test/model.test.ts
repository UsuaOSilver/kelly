import { describe, expect, it } from "vitest";
import { analyzeEvent, kellyFraction, normCdf, probAbove, realizedVol, sizeBet, walkBook } from "../src/model.ts";
import type { GEvent, Kline } from "../src/gemini.ts";

const HOUR = 3600_000;
/** Deterministic candles: alternating ±r log returns every 5 minutes. */
function candles(n: number, start: number, r: number): Kline[] {
  const out: Kline[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p *= Math.exp(i % 2 ? r : -r);
    out.push([i * 300_000, p, p, p, p, 0]);
  }
  return out.reverse(); // Gemini returns newest first
}

describe("normCdf", () => {
  it("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1)).toBeCloseTo(0.1587, 3);
  });
});

describe("realizedVol", () => {
  it("annualises 5-minute returns and is order-independent", () => {
    const k = candles(200, 100, 0.001);
    const a = realizedVol(k);
    const b = realizedVol([...k].reverse());
    expect(a.sigma).toBeCloseTo(b.sigma, 10);
    // |r| = 0.001 per 5m → sigma ≈ 0.001 * sqrt(105120)
    expect(a.sigma).toBeCloseTo(0.001 * Math.sqrt((365 * 24 * 60) / 5), 1);
  });
  it("refuses to guess from too little data", () => {
    expect(() => realizedVol(candles(5, 100, 0.001))).toThrow();
  });
});

describe("probAbove", () => {
  it("is about one half at the money and monotone in strike", () => {
    expect(probAbove(100, 100, 0.5, 24 * HOUR)).toBeGreaterThan(0.48);
    expect(probAbove(100, 100, 0.5, 24 * HOUR)).toBeLessThan(0.5);
    expect(probAbove(100, 90, 0.5, 24 * HOUR)).toBeGreaterThan(probAbove(100, 110, 0.5, 24 * HOUR));
  });
  it("collapses to the payoff at expiry", () => {
    expect(probAbove(101, 100, 0.5, 0)).toBe(1);
    expect(probAbove(99, 100, 0.5, 0)).toBe(0);
  });
});

describe("kellyFraction", () => {
  it("is (p - price) / (1 - price) and never negative", () => {
    expect(kellyFraction(0.5, 0.4)).toBeCloseTo(1 / 6, 10);
    expect(kellyFraction(0.3, 0.4)).toBe(0);
    expect(kellyFraction(0.9, 1)).toBe(0);
  });
});

describe("walkBook", () => {
  const book = { bids: [{ price: "0.60", amount: "100" }, { price: "0.55", amount: "50" }], asks: [{ price: "0.64", amount: "10" }, { price: "0.70", amount: "100" }] };
  it("lifts asks for YES and respects the limit", () => {
    const f = walkBook(book, "yes", 50, 0.66);
    expect(f.contracts).toBe(10);
    expect(f.cost).toBeCloseTo(6.4, 6);
    expect(f.exhausted).toBe(true);
  });
  it("walks multiple levels", () => {
    const f = walkBook(book, "yes", 20, 0.99);
    expect(f.levels).toBe(2);
    expect(f.cost).toBeLessThanOrEqual(20);
    expect(f.avgPrice).toBeGreaterThan(0.64);
  });
  it("buys NO against bids at 1 - bid", () => {
    const f = walkBook(book, "no", 20, 0.42);
    expect(f.worstPrice).toBeCloseTo(0.4, 6);
    expect(f.contracts).toBe(50);
  });
});

describe("sizeBet", () => {
  const base = { p: 0.5, price: 0.4, bankroll: 200, fraction: 0.5, remainingToday: 50, liquidityUsd: 1000 };
  it("uses fractional Kelly", () => {
    const s = sizeBet(base);
    expect(s.raw).toBeCloseTo(16.67, 2);
    expect(s.stake).toBeCloseTo(16.66, 2);
    expect(s.cappedBy).toEqual([]);
  });
  it("caps by the daily allowance and by book depth", () => {
    expect(sizeBet({ ...base, p: 0.9 }).cappedBy).toContain("daily cap");
    const thin = sizeBet({ ...base, liquidityUsd: 3 });
    expect(thin.stake).toBe(3);
    expect(thin.cappedBy).toContain("book depth");
  });
  it("does not silently shrink an explicit request to fit the daily cap (the vault decides that)", () => {
    expect(sizeBet({ ...base, requested: 500 }).stake).toBe(500);
  });
});

describe("analyzeEvent", () => {
  const now = 1_000_000_000_000;
  const ev = (contracts: [number, string, string][]): GEvent => ({
    ticker: "BTCTEST", title: "BTC test", category: "Crypto", type: "categorical", template: "prices-ladder", status: "active",
    expiryDate: new Date(now + 24 * HOUR).toISOString(), sourceDetails: { agency: "lukka", index: "LS-LRRR-XBTUSD" },
    contracts: contracts.map(([k, bid, ask]) => ({ label: `$${k} or above`, ticker: `HI${k}`, instrumentSymbol: `GEMI-BTCTEST-HI${k}`, status: "active", marketState: "open", expiryDate: "", strike: { type: "above", value: String(k) }, prices: { bestBid: bid, bestAsk: ask } })),
  });
  const k = candles(288, 100, 0.0015);

  it("picks YES when the ask is below the model and NO when the bid is above it", () => {
    const a = analyzeEvent(ev([[100, "0.38", "0.40"], [102, "0.52", "0.55"]]), k, now, 0.03, 100);
    const [atm, otm] = a.rows;
    expect(atm.side).toBe("yes");
    expect(atm.edge).toBeCloseTo(atm.model - 0.4, 10);
    expect(otm.side).toBe("no");
    expect(otm.edge).toBeCloseTo(0.52 - otm.model, 10);
  });
  it("uses the live spot over the candle close", () => {
    const stale = analyzeEvent(ev([[100, "0.48", "0.50"]]), k, now, 0.03);
    const live = analyzeEvent(ev([[100, "0.48", "0.50"]]), k, now, 0.03, 103);
    expect(live.rows[0].model).toBeGreaterThan(stale.rows[0].model);
  });
  it("finds nothing in a fairly priced ladder", () => {
    const fair = analyzeEvent(ev([[100, "0.48", "0.50"]]), k, now, 0.03, 100);
    expect(fair.best).toBeNull();
  });
  it("distrusts edges that are too good to be true", () => {
    const a = analyzeEvent(ev([[100, "0.08", "0.10"]]), k, now, 0.03, 100, 0.15);
    expect(a.best).toBeNull();
    expect(a.suspect).toBe(1);
  });
});
