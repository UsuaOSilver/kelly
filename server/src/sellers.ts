// Three independent signal sellers. Each endpoint costs a fraction of a cent and is
// paid per request over x402. In gateway mode the paywall is Circle's own middleware.
import express, { type RequestHandler } from "express";
import fs from "node:fs";
import path from "node:path";
import { cfg, ROOT } from "./config.ts";
import { getBook, getEvent, getKlines, getSpot, listEvents, marketNow, num } from "./gemini.ts";
import { analyzeEvent, realizedVol, walkBook, type Side } from "./model.ts";
import { SIM_NETWORK, simGateway } from "./pay.ts";

export type Seller = { id: string; name: string; blurb: string; path: string; priceUsd: number; address: string };

const SIM_ADDRS = ["0x5e11e70000000000000000000000000000000001", "0x5e11e70000000000000000000000000000000002", "0x5e11e70000000000000000000000000000000003"];

export function buildSellers(addresses: string[]): Seller[] {
  const a = addresses.length >= 3 ? addresses : SIM_ADDRS;
  return [
    { id: "sigma", name: "Sigma", blurb: "Fair-value odds from realised volatility of the reference index", path: "/sellers/sigma/fair-value", priceUsd: 0.005, address: a[0] },
    { id: "depth", name: "Depth", blurb: "Order-book walk: what a given stake really fills at", path: "/sellers/depth/liquidity", priceUsd: 0.002, address: a[1] },
    { id: "tape", name: "Tape", blurb: "Odds history Gemini does not serve, plus index momentum", path: "/sellers/tape/history", priceUsd: 0.001, address: a[2] },
  ];
}

// ─────────────── Tape's recorder: Gemini has no candles for contracts, so we keep our own ───────────────

const TAPE_FILE = path.join(ROOT, "server", "data", "tape.json");
type TapePoint = { t: number; mids: Record<string, number> };
const tape = new Map<string, TapePoint[]>();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(TAPE_FILE, "utf8")))) tape.set(k, v as TapePoint[]);
} catch {
  /* first run */
}

export async function recordTape() {
  const events = (await listEvents({ category: "Crypto" })).filter((e) => e.template === "prices-ladder");
  const t = marketNow();
  for (const e of events) {
    const mids: Record<string, number> = {};
    for (const c of e.contracts) {
      const b = num(c.prices?.bestBid);
      const a = num(c.prices?.bestAsk);
      if (b != null && a != null) mids[c.instrumentSymbol] = (a + b) / 2;
    }
    const arr = tape.get(e.ticker) ?? [];
    if (!arr.length || t - arr[arr.length - 1].t >= 30_000) arr.push({ t, mids });
    tape.set(e.ticker, arr.slice(-720));
  }
  const live = new Set(events.map((e) => e.ticker));
  for (const k of tape.keys()) if (!live.has(k)) tape.delete(k);
  fs.mkdirSync(path.dirname(TAPE_FILE), { recursive: true });
  fs.writeFileSync(TAPE_FILE, JSON.stringify(Object.fromEntries(tape)));
}

// ─────────────────────────────── paywall ───────────────────────────────

function simPaywall(s: Seller): RequestHandler {
  return async (req, res, next) => {
    const amount = String(Math.round(s.priceUsd * 1e6));
    const resource = `${cfg.publicUrl}${req.originalUrl}`;
    const sig = req.header("PAYMENT-SIGNATURE");
    if (!sig) {
      const required = {
        x402Version: 2,
        resource: { url: resource, description: s.blurb, mimeType: "application/json" },
        accepts: [{ scheme: "exact", network: SIM_NETWORK, asset: "USDC", amount, payTo: s.address, maxTimeoutSeconds: 60, extra: { name: "KellySimFacilitator", version: "1" } }],
      };
      res.status(402).set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(required)).toString("base64")).json({ error: "payment_required" });
      return;
    }
    try {
      const { payload } = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
      const r = await simGateway.settle(payload, { to: s.address, value: amount, resource });
      if (!r.ok) {
        res.status(402).json({ error: r.reason });
        return;
      }
      next();
    } catch {
      res.status(402).json({ error: "invalid_payload" });
    }
  };
}

async function paywall(s: Seller): Promise<RequestHandler> {
  if (cfg.payMode === "sim") return simPaywall(s);
  const { createGatewayMiddleware } = await import("@circle-fin/x402-batching/server");
  const gateway = createGatewayMiddleware({ sellerAddress: s.address, facilitatorUrl: cfg.gatewayFacilitator, networks: ["eip155:5042002"], description: s.blurb });
  return gateway.require(`$${s.priceUsd}`) as unknown as RequestHandler;
}

// ─────────────────────────────── routes ───────────────────────────────

export async function sellersRouter(sellers: Seller[]) {
  const r = express.Router();
  const [sigma, depth, tapeS] = sellers;
  const wrap = (fn: (req: express.Request) => Promise<unknown>, s: Seller): RequestHandler => async (req, res) => {
    try {
      res.json({ ...(await fn(req) as object), _seller: s.address, _price: s.priceUsd });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };

  /** Free: how an agent discovers what is for sale and at what price. */
  r.get("/catalog", (_req, res) => res.json({ sellers: sellers.map((s) => ({ ...s, url: `${cfg.publicUrl}${s.path}`, currency: "USDC", protocol: "x402" })) }));

  r.get(
    "/sigma/fair-value",
    await paywall(sigma),
    wrap(async (req) => {
      const ev = await getEvent(String(req.query.event));
      if (!ev.sourceDetails) throw new Error("Event has no reference index");
      const klines = await getKlines(ev.sourceDetails.agency, ev.sourceDetails.index, "5m", 24);
      const spot = await getSpot(ev.sourceDetails.index);
      return { ...analyzeEvent(ev, klines, marketNow(), cfg.minEdge, spot, cfg.maxEdge), spotSource: spot ? "gemini-spot-mid" : "index-candle-close" };
    }, sigma),
  );

  r.get(
    "/depth/liquidity",
    await paywall(depth),
    wrap(async (req) => {
      const side = (req.query.side === "no" ? "no" : "yes") as Side;
      const usdAmt = Number(req.query.usd ?? 10);
      const limit = Number(req.query.limit ?? 0.99);
      const book = await getBook(String(req.query.symbol));
      const fill = walkBook(book, side, usdAmt, limit);
      const all = walkBook(book, side, 1e9, limit);
      return { symbol: req.query.symbol, side, requestedUsd: usdAmt, limit, fill, availableUsd: all.cost, availableContracts: all.contracts, bids: book.bids.length, asks: book.asks.length };
    }, depth),
  );

  r.get(
    "/tape/history",
    await paywall(tapeS),
    wrap(async (req) => {
      const ev = await getEvent(String(req.query.event));
      const symbol = String(req.query.symbol ?? "");
      const pts = (tape.get(ev.ticker) ?? []).filter((p) => p.mids[symbol] != null).map((p) => ({ t: p.t, mid: p.mids[symbol] }));
      const klines = ev.sourceDetails ? await getKlines(ev.sourceDetails.agency, ev.sourceDetails.index, "5m", 24) : [];
      const rows = [...klines].sort((a, b) => a[0] - b[0]);
      const last = rows.at(-1)?.[4] ?? 0;
      const hourAgo = rows.at(-13)?.[4] ?? last;
      const { sigma } = klines.length ? realizedVol(klines) : { sigma: 0 };
      return {
        event: ev.ticker,
        symbol,
        points: pts.slice(-120),
        oddsChange: pts.length >= 2 ? pts.at(-1)!.mid - pts[0].mid : null,
        windowMinutes: pts.length >= 2 ? (pts.at(-1)!.t - pts[0].t) / 60_000 : 0,
        indexChange1hPct: hourAgo ? ((last - hourAgo) / hourAgo) * 100 : 0,
        sigma,
      };
    }, tapeS),
  );

  return r;
}
