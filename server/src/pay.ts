// How the agent pays for data: x402, one sub-cent USDC payment per request.
//   gateway — Circle Gateway nanopayments on Arc testnet (@circle-fin/x402-batching)
//   sim     — the same 402 handshake against a local facilitator, signed with the agent key
import { verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cfg, usd } from "./config.ts";
import { log } from "./ledger.ts";

export class PolicyBlock extends Error {
  constructor(public rule: string, msg: string) {
    super(msg);
  }
}

export const agentAccount = privateKeyToAccount((cfg.agentKey || generatePrivateKey()) as Hex);

// ───────────── offchain data-spend policy (enforced before anything is signed) ─────────────

export const dataPolicy = {
  allowedSellers: new Set<string>(),
  spentUsd: 0,
  calls: 0,
  check(seller: string, priceUsd: number, what: string) {
    const fail = (rule: string, msg: string) => {
      log({ kind: "blocked", title: `Blocked payment for ${what}`, detail: msg, amountUsd: priceUsd, to: seller, source: "policy" });
      throw new PolicyBlock(rule, msg);
    };
    if (!this.allowedSellers.has(seller.toLowerCase())) fail("seller-allowlist", `Seller ${seller} is not on the allowlist.`);
    if (priceUsd > cfg.maxPricePerCallUsd) fail("max-price-per-call", `Price ${usd(priceUsd)} is above the ${usd(cfg.maxPricePerCallUsd)} per-call limit.`);
    if (this.spentUsd + priceUsd > cfg.dataBudgetPerSessionUsd)
      fail("session-data-budget", `Would exceed the ${usd(cfg.dataBudgetPerSessionUsd)} data budget for this session.`);
  },
  record(priceUsd: number) {
    this.spentUsd += priceUsd;
    this.calls++;
  },
};

// ───────────────────────────── sim facilitator ─────────────────────────────

export const SIM_NETWORK = "sim:local";
const SIM_DOMAIN = { name: "KellySimFacilitator", version: "1", chainId: 31337 } as const;
const SIM_TYPES = {
  Payment: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "resource", type: "string" },
  ],
} as const;

export const simGateway = {
  balances: new Map<string, number>(),
  seen: new Set<string>(),
  credit(addr: string, usdAmt: number) {
    const k = addr.toLowerCase();
    this.balances.set(k, (this.balances.get(k) ?? 0) + usdAmt);
  },
  balance(addr: string) {
    return this.balances.get(addr.toLowerCase()) ?? 0;
  },
  /** Verify the buyer's signature, reject replays, and move the balance. */
  async settle(p: { from: Hex; to: Hex; value: string; nonce: Hex; resource: string; signature: Hex }, expected: { to: string; value: string; resource: string }) {
    if (p.to.toLowerCase() !== expected.to.toLowerCase() || p.value !== expected.value || p.resource !== expected.resource) return { ok: false, reason: "invalid_payload" };
    const ok = await verifyTypedData({
      address: p.from,
      domain: SIM_DOMAIN,
      types: SIM_TYPES,
      primaryType: "Payment",
      message: { from: p.from, to: p.to, value: BigInt(p.value), nonce: p.nonce, resource: p.resource },
      signature: p.signature,
    });
    if (!ok) return { ok: false, reason: "invalid_signature" };
    if (this.seen.has(p.nonce)) return { ok: false, reason: "replayed_nonce" };
    const amt = Number(p.value) / 1e6;
    if (this.balance(p.from) + 1e-9 < amt) return { ok: false, reason: "insufficient_funds" };
    this.seen.add(p.nonce);
    this.credit(p.from, -amt);
    this.credit(p.to, amt);
    return { ok: true, reason: "" };
  },
};

// ─────────────────────────────── payer ───────────────────────────────

export type Paid<T> = { data: T; priceUsd: number; seller: string; ref: string; source: string };

let gatewayClient: any = null;
async function gw() {
  if (!gatewayClient) {
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    gatewayClient = new GatewayClient({ chain: "arcTestnet", privateKey: cfg.agentKey as Hex });
    // Circle's own pre-signing hook: the policy runs inside the SDK, so nothing over-limit is ever signed.
    gatewayClient.onBeforePaymentCreation(async (ctx: any) => {
      const r = ctx.selectedRequirements;
      try {
        dataPolicy.check(r.payTo, Number(r.amount) / 1e6, new URL(ctx.paymentRequired?.resource?.url ?? "http://x/resource").pathname);
      } catch (e) {
        return { abort: true, reason: (e as Error).message };
      }
    });
  }
  return gatewayClient;
}

export async function gatewayBalanceUsd(): Promise<number> {
  if (cfg.payMode === "sim") return simGateway.balance(agentAccount.address);
  const b = await (await gw()).getBalances();
  return Number(b.gateway.formattedAvailable);
}

/** Move freshly-released vault USDC into the nanopayment balance. */
export async function depositToGateway(usdAmt: number): Promise<string> {
  if (cfg.payMode === "sim") {
    simGateway.credit(agentAccount.address, usdAmt);
    return "sim";
  }
  const r = await (await gw()).deposit(usdAmt.toFixed(6));
  return r.depositTxHash;
}

export async function payFor<T>(url: string, what: string): Promise<Paid<T>> {
  if (cfg.payMode === "gateway") {
    const client = await gw();
    try {
      const r = await client.pay(url);
      const priceUsd = Number(r.formattedAmount);
      dataPolicy.record(priceUsd);
      const seller = (r.data as any)?._seller ?? "";
      log({ kind: "data_payment", title: what, amountUsd: priceUsd, to: seller, tx: r.transaction, source: "gateway" });
      return { data: r.data as T, priceUsd, seller, ref: r.transaction, source: "gateway" };
    } catch (e) {
      const m = String((e as Error).message);
      if (m.includes("aborted")) throw new PolicyBlock("policy", m.replace(/^.*aborted:\s*/, ""));
      throw e;
    }
  }

  // sim: a real 402 round trip against our local facilitator
  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`Expected 402 from ${url}, got ${first.status}`);
  const required = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
  const req = required.accepts.find((a: any) => a.network === SIM_NETWORK);
  if (!req) throw new Error("Seller offers no payment option this agent supports");
  const priceUsd = Number(req.amount) / 1e6;
  dataPolicy.check(req.payTo, priceUsd, what);

  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex;
  const message = { from: agentAccount.address, to: req.payTo as Hex, value: BigInt(req.amount), nonce, resource: required.resource.url as string };
  const signature = await agentAccount.signTypedData({ domain: SIM_DOMAIN, types: SIM_TYPES, primaryType: "Payment", message });
  const payload = { x402Version: 2, payload: { ...message, value: req.amount, signature } };
  const second = await fetch(url, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
  if (!second.ok) throw new Error(`Payment rejected: ${(await second.json().catch(() => ({})) as any).error ?? second.status}`);
  dataPolicy.record(priceUsd);
  log({ kind: "data_payment", title: what, amountUsd: priceUsd, to: req.payTo, tx: nonce, source: "sim-facilitator" });
  return { data: (await second.json()) as T, priceUsd, seller: req.payTo, ref: nonce, source: "sim-facilitator" };
}
