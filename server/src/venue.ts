// Where the bet is actually placed. Default is a paper fill against Gemini's live order book.
// With API keys and GEMINI_LIVE_TRADING=true it sends a real limit order instead.
import crypto from "node:crypto";
import { cfg } from "./config.ts";
import { getBook, getEvent, num } from "./gemini.ts";
import { round2, walkBook, type Side } from "./model.ts";

export type Position = {
  id: string;
  intentId: string;
  event: string;
  symbol: string;
  label: string;
  side: Side;
  contracts: number;
  avgPrice: number;
  costUsd: number;
  unfilledUsd: number;
  modelP: number;
  mode: "paper" | "gemini-live";
  orderId?: string;
  ts: number;
  markPrice?: number;
  pnlUsd?: number;
};

export const positions: Position[] = [];

export async function placeOrder(o: { intentId: string; event: string; symbol: string; label: string; side: Side; usd: number; limitPrice: number; modelP: number }): Promise<Position> {
  const book = await getBook(o.symbol);
  const fill = walkBook(book, o.side, o.usd, o.limitPrice);
  let mode: Position["mode"] = "paper";
  let orderId: string | undefined;

  if (cfg.liveTrading && cfg.geminiKey && cfg.geminiSecret && fill.contracts > 0) {
    orderId = await geminiLimitOrder({ symbol: o.symbol, side: "buy", outcome: o.side, quantity: fill.contracts.toFixed(2), price: o.limitPrice.toFixed(2) });
    mode = "gemini-live";
  }

  const p: Position = {
    id: `pos_${positions.length + 1}`,
    intentId: o.intentId,
    event: o.event,
    symbol: o.symbol,
    label: o.label,
    side: o.side,
    contracts: fill.contracts,
    avgPrice: fill.avgPrice,
    costUsd: fill.cost,
    unfilledUsd: round2(o.usd - fill.cost),
    modelP: o.modelP,
    mode,
    orderId,
    ts: Date.now(),
  };
  positions.push(p);
  return p;
}

/** Mark open positions at the price they could be sold for right now. */
export async function markPositions(): Promise<Position[]> {
  const byEvent = new Map<string, Position[]>();
  for (const p of positions) byEvent.set(p.event, [...(byEvent.get(p.event) ?? []), p]);
  for (const [event, ps] of byEvent) {
    try {
      const ev = await getEvent(event);
      for (const p of ps) {
        const c = ev.contracts.find((x) => x.instrumentSymbol === p.symbol);
        const bid = num(c?.prices?.bestBid);
        const ask = num(c?.prices?.bestAsk);
        const mark = p.side === "yes" ? bid : ask == null ? null : 1 - ask;
        if (mark != null) {
          p.markPrice = round2(mark);
          p.pnlUsd = round2(p.contracts * mark - p.costUsd);
        }
      }
    } catch {
      /* event expired or unreachable: keep the last mark */
    }
  }
  return positions;
}

/**
 * POST /v1/prediction-markets/order with Gemini's standard signed-payload headers.
 * NOTE: written from the docs and not exercised — we had no trading keys during the hackathon.
 */
async function geminiLimitOrder(body: { symbol: string; side: "buy"; outcome: Side; quantity: string; price: string }): Promise<string> {
  const request = "/v1/prediction-markets/order";
  const payload = Buffer.from(JSON.stringify({ request, nonce: Date.now(), orderType: "limit", timeInForce: "immediate-or-cancel", ...body })).toString("base64");
  const signature = crypto.createHmac("sha384", cfg.geminiSecret).update(payload).digest("hex");
  const r = await fetch(`https://api.gemini.com${request}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-GEMINI-APIKEY": cfg.geminiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": signature, "Cache-Control": "no-cache" },
  });
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(`Gemini order rejected: ${j.message ?? j.reason ?? r.status}`);
  return String(j.orderId ?? j.order_id ?? j.id ?? "");
}
