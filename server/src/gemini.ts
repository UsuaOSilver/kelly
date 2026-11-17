// Thin client for Gemini Prediction Markets public market data (no API key needed).
// Docs: https://developer.gemini.com/prediction-markets/market-data
import fs from "node:fs";
import path from "node:path";
import { cfg, ROOT } from "./config.ts";

const BASE = "https://api.gemini.com";
const FIXTURE = path.join(ROOT, "server", "fixtures", "gemini.json");

export type Contract = {
  label: string;
  ticker: string;
  instrumentSymbol: string;
  marketState?: string;
  status: string;
  expiryDate: string;
  strike?: { type: string; value: string };
  prices?: {
    buy?: { yes?: string; no?: string };
    sell?: { yes?: string; no?: string };
    bestBid?: string;
    bestAsk?: string;
    lastTradePrice?: string;
  };
};
export type GEvent = {
  ticker: string;
  title: string;
  category: string;
  type: string;
  template?: string;
  series?: string;
  status: string;
  expiryDate: string;
  volume?: string;
  volume24h?: string;
  sourceDetails?: { agency: string; index: string };
  contracts: Contract[];
};
export type Book = { bids: { price: string; amount: string }[]; asks: { price: string; amount: string }[] };
/** [timestampMs, open, high, low, close, volume], newest first */
export type Kline = [number, number, number, number, number, number];

type Fixture = {
  recordedAt: string;
  events: GEvent[];
  klines: Record<string, Kline[]>;
  books: Record<string, Book>;
  spots?: Record<string, number>;
};

let fixture: Fixture | null = null;
function fx(): Fixture {
  if (!fixture) fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  return fixture!;
}

/** Which source answered the most recent call — shown in the UI so a fallback is never silent. */
export const sourceState = { last: cfg.geminiSource as "live" | "fixture", fixtureRecordedAt: "", lastError: "" };

async function get<T>(url: string, fallback: () => T): Promise<T> {
  if (cfg.geminiSource === "fixture") {
    sourceState.last = "fixture";
    sourceState.fixtureRecordedAt = fx().recordedAt;
    return fallback();
  }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`Gemini ${r.status} for ${url}`);
    const j = (await r.json()) as T;
    sourceState.last = "live";
    return j;
  } catch (e) {
    sourceState.lastError = String((e as Error).message);
    if (!fs.existsSync(FIXTURE)) throw e;
    sourceState.last = "fixture";
    sourceState.fixtureRecordedAt = fx().recordedAt;
    return fallback();
  }
}

export async function listEvents(params: { category?: string; search?: string; limit?: number } = {}): Promise<GEvent[]> {
  const q = new URLSearchParams({ status: "active", limit: String(params.limit ?? 200) });
  if (params.category) q.set("category", params.category);
  if (params.search) q.set("search", params.search);
  const j = await get<{ data: GEvent[] }>(`${BASE}/v1/prediction-markets/events?${q}`, () => ({
    data: fx().events.filter(
      (e) =>
        (!params.category || e.category === params.category) &&
        (!params.search || e.title.toLowerCase().includes(params.search.toLowerCase())),
    ),
  }));
  return j.data;
}

export async function getEvent(ticker: string): Promise<GEvent> {
  return get<GEvent>(`${BASE}/v1/prediction-markets/events/${encodeURIComponent(ticker)}`, () => {
    const e = fx().events.find((x) => x.ticker === ticker);
    if (!e) throw new Error(`Event ${ticker} is not in the fixture`);
    return e;
  });
}

export async function getBook(instrumentSymbol: string): Promise<Book> {
  return get<Book>(`${BASE}/v1/book/${encodeURIComponent(instrumentSymbol)}`, () => {
    const b = fx().books[instrumentSymbol];
    if (!b) throw new Error(`Book ${instrumentSymbol} is not in the fixture`);
    return b;
  });
}

export async function getKlines(agency: string, index: string, interval = "5m", hours = 24): Promise<Kline[]> {
  const end = Date.now();
  const q = new URLSearchParams({ agency, index, interval, startTime: String(end - hours * 3600_000), endTime: String(end) });
  return get<Kline[]>(`${BASE}/v2/klines?${q}`, () => {
    const k = fx().klines[`${index}:${interval}`] ?? fx().klines[index];
    if (!k) throw new Error(`Klines ${index} are not in the fixture`);
    return k;
  });
}

const SPOT_SYMBOL: Record<string, string> = {
  "LS-LRRR-XBTUSD": "btcusd",
  "LS-LRRR-ETHUSD": "ethusd",
  "LS-LRRR-SOLNUSD": "solusd",
  "LS-LRRR-XRPUSD": "xrpusd",
  "LS-LRRR-ZECUSD": "zecusd",
  "LS-LRRR-HYPE22USD": "hypeusd",
};

/**
 * Live level for a reference index. The index candles on /v2/klines trail real time by several
 * minutes, which is enough to fake an edge on a market that settles within hours, so the current
 * level comes from Gemini's own spot order book (mid). Returns null if that pair is unavailable.
 * The settlement index is Lukka's, so a small basis versus Gemini spot remains.
 */
export async function getSpot(index: string): Promise<number | null> {
  const sym = SPOT_SYMBOL[index];
  if (!sym) return null;
  try {
    const t = await get<{ bid: string; ask: string }>(`${BASE}/v1/pubticker/${sym}`, () => {
      const v = fx().spots?.[index];
      if (v == null) throw new Error(`Spot ${index} is not in the fixture`);
      return { bid: String(v), ask: String(v) };
    });
    const mid = (Number(t.bid) + Number(t.ask)) / 2;
    return Number.isFinite(mid) && mid > 0 ? mid : null;
  } catch {
    return null;
  }
}

/** In fixture mode "now" is the moment the fixture was recorded, so time-to-expiry stays meaningful. */
export function marketNow(): number {
  return sourceState.last === "fixture" && fs.existsSync(FIXTURE) ? Date.parse(fx().recordedAt) : Date.now();
}

export const num = (s?: string) => (s == null || s === "" ? null : Number(s));
