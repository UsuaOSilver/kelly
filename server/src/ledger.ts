// One append-only activity log that the UI renders and the agent reacts to.
import { EventEmitter } from "node:events";

export type Kind =
  | "step" // a decision-loop step, for transparency
  | "data_payment" // x402 nanopayment to a signal seller
  | "blocked" // a guardrail said no
  | "vault_spent"
  | "vault_requested"
  | "vault_denied"
  | "vault_paused"
  | "vault_policy"
  | "order"
  | "info";

export type Entry = {
  id: number;
  ts: number;
  kind: Kind;
  title: string;
  detail?: string;
  amountUsd?: number;
  to?: string;
  tx?: string;
  /** Where this fact came from: sim | rpc-poll | quicknode | gateway | sim-facilitator | gemini | paper | agent */
  source: string;
  intentId?: string;
  requestId?: string;
};

export const bus = new EventEmitter();
bus.setMaxListeners(100);
const entries: Entry[] = [];
let seq = 0;

export function log(e: Omit<Entry, "id" | "ts">): Entry {
  const entry = { ...e, id: ++seq, ts: Date.now() };
  entries.push(entry);
  if (entries.length > 500) entries.shift();
  bus.emit("entry", entry);
  return entry;
}

export const recent = (n = 80) => entries.slice(-n);
export const step = (title: string, detail?: string, intentId?: string) => log({ kind: "step", title, detail, source: "agent", intentId });
export function resetLedger() {
  entries.length = 0;
}
