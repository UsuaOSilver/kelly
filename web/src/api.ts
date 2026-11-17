export type Row = { symbol: string; label: string; strike: number; bid: number | null; ask: number | null; mid: number | null; model: number; side: "yes" | "no" | null; price: number | null; edge: number | null };
export type Analysis = { event: string; title: string; index: string; spot: number; sigma: number; hoursToExpiry: number; expiry: string; rows: Row[]; best: Row | null; suspect: number };
export type Entry = { id: number; ts: number; kind: string; title: string; detail?: string; amountUsd?: number; to?: string; tx?: string; source: string; intentId?: string; requestId?: string };
export type Intent = { id: string; title: string; label: string; side: "yes" | "no"; price: number; modelP: number; edge: number; stakeUsd: number; status: string };
export type Position = { id: string; label: string; event: string; side: "yes" | "no"; contracts: number; avgPrice: number; costUsd: number; unfilledUsd: number; mode: string; markPrice?: number; pnlUsd?: number };
export type State = {
  vault: { mode: string; address: string; network: string; balanceUsd: number; autoApproveUsd: number; dailyCapUsd: number; spentTodayUsd: number; remainingTodayUsd: number; paused: boolean };
  agent: string;
  data: { gatewayBalanceUsd: number; spentUsd: number; calls: number; budgetUsd: number; maxPerCallUsd: number };
  pending: { requestId: string; amountUsd: number; to: string; tx: string; source: string; intent?: Intent }[];
  positions: Position[];
  analysis: Analysis | null;
  pick: string | null;
  sellers: { id: string; name: string; blurb: string; priceUsd: number; address: string }[];
  modes: { chain: string; pay: string; events: string; gemini: string; geminiFixtureAt: string; trading: string; explorer: string };
  ledger: Entry[];
};
export type ToolResult = { ok: boolean; say: string; data?: unknown };

const post = async (path: string, body: unknown = {}): Promise<ToolResult> => {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch {
    return { ok: false, say: "I can't reach the Kelly server." };
  }
};

export const api = {
  state: async (): Promise<State> => (await fetch("/api/state")).json(),
  config: async (): Promise<{ elevenAgentId: string; hasElevenKey: boolean }> => (await fetch("/api/config")).json(),
  chat: (text: string) => post("/api/chat", { text }),
  scan: (asset?: string) => post("/api/tools/scan", { asset }),
  propose: (usd?: number) => post("/api/tools/propose", { usd }),
  approve: (requestId?: string) => post("/api/tools/approve", { requestId }),
  deny: (requestId?: string) => post("/api/tools/deny", { requestId }),
  pause: (on: boolean) => post("/api/tools/pause", { on }),
  status: () => post("/api/tools/status"),
};

export const usd = (n: number, dp?: number) => {
  const d = dp ?? (Math.abs(n) > 0 && Math.abs(n) < 1 ? 3 : 2);
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(d)}`;
};
export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
