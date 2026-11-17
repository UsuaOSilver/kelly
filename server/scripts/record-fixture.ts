// Records a snapshot of live Gemini data so the whole demo can run offline.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";

const BASE = "https://api.gemini.com";
const j = async (u: string) => (await fetch(u)).json() as Promise<any>;

const events = (await j(`${BASE}/v1/prediction-markets/events?status=active&limit=200&category=Crypto`)).data.filter((e: any) => e.template === "prices-ladder");
for (const e of events) for (const c of e.contracts) delete c.description;

const SPOT: Record<string, string> = { "LS-LRRR-XBTUSD": "btcusd", "LS-LRRR-ETHUSD": "ethusd", "LS-LRRR-SOLNUSD": "solusd", "LS-LRRR-XRPUSD": "xrpusd", "LS-LRRR-ZECUSD": "zecusd", "LS-LRRR-HYPE22USD": "hypeusd" };
const klines: Record<string, unknown> = {};
const spots: Record<string, number> = {};
const end = Date.now();
for (const index of new Set<string>(events.map((e: any) => e.sourceDetails?.index).filter(Boolean))) {
  klines[index] = await j(`${BASE}/v2/klines?agency=lukka&index=${index}&interval=5m&startTime=${end - 24 * 3600_000}&endTime=${end}`);
  const t = await j(`${BASE}/v1/pubticker/${SPOT[index]}`);
  spots[index] = (Number(t.bid) + Number(t.ask)) / 2;
}

const books: Record<string, unknown> = {};
const liquid = events.filter((e: any) => /^(BTC|ETH|SOL)/.test(e.ticker));
for (const e of liquid) for (const c of e.contracts) books[c.instrumentSymbol] = await j(`${BASE}/v1/book/${c.instrumentSymbol}`);

const out = path.join(ROOT, "server", "fixtures", "gemini.json");
fs.writeFileSync(out, JSON.stringify({ recordedAt: new Date().toISOString(), events, klines, books, spots }));
console.log(`Recorded ${events.length} events, ${Object.keys(klines).length} indices, ${Object.keys(books).length} books → ${out}`);
