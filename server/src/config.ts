import "dotenv/config";
import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadEnv({ path: path.join(ROOT, ".env") });

const env = (k: string, d = "") => process.env[k]?.trim() || d;

/** sim = in-memory mirror of the vault rules. rpc = a real chain (local Hardhat node or Arc). */
export type ChainMode = "sim" | "rpc";
/** sim = local x402 facilitator. gateway = Circle Gateway nanopayments on Arc testnet. */
export type PayMode = "sim" | "gateway";

export const cfg = {
  port: Number(env("PORT", "8787")),
  publicUrl: env("PUBLIC_URL", `http://localhost:${env("PORT", "8787")}`),

  chainMode: env("CHAIN_MODE", "sim") as ChainMode,
  payMode: env("PAY_MODE", "sim") as PayMode,
  /** live = api.gemini.com with automatic fallback to the recorded fixture. fixture = never touch the network. */
  geminiSource: env("GEMINI_SOURCE", "live") as "live" | "fixture",

  rpcUrl: env("RPC_URL", "http://127.0.0.1:8545"),
  deployment: env("DEPLOYMENT", "localhost"),
  explorer: env("EXPLORER_URL", ""),
  ownerKey: env("OWNER_PRIVATE_KEY"),
  agentKey: env("AGENT_PRIVATE_KEY"),

  gatewayFacilitator: env("GATEWAY_FACILITATOR_URL", "https://gateway-api-testnet.circle.com"),
  sellerAddresses: env("SELLER_ADDRESSES").split(",").map((s) => s.trim()).filter(Boolean),

  quicknodeToken: env("QUICKNODE_SECURITY_TOKEN"),
  /** When a QuickNode Stream is delivering vault events, turn the RPC poller off so the Stream is the only source. */
  eventSource: env("EVENT_SOURCE", "auto") as "auto" | "quicknode" | "rpc",

  elevenKey: env("ELEVENLABS_API_KEY"),
  elevenAgentId: env("ELEVENLABS_AGENT_ID"),
  elevenVoiceId: env("ELEVENLABS_VOICE_ID", "cjVigY5qzO86Huf0OWal"),

  geminiKey: env("GEMINI_API_KEY"),
  geminiSecret: env("GEMINI_API_SECRET"),
  liveTrading: env("GEMINI_LIVE_TRADING", "false") === "true",

  // Offchain policy for data purchases (the onchain vault governs everything that leaves the vault).
  maxPricePerCallUsd: Number(env("MAX_PRICE_PER_CALL_USD", "0.02")),
  dataBudgetPerSessionUsd: Number(env("DATA_BUDGET_PER_SESSION_USD", "0.50")),
  dataTopUpUsd: Number(env("DATA_TOPUP_USD", "1")),
  minStakeUsd: Number(env("MIN_STAKE_USD", "1")),
  minEdge: Number(env("MIN_EDGE", "0.03")),
  maxEdge: Number(env("MAX_EDGE", "0.15")),
  kellyFraction: Number(env("KELLY_FRACTION", "0.5")),

  // Sim-mode starting state
  simVaultUsd: Number(env("SIM_VAULT_USD", "200")),
  simAutoApproveUsd: Number(env("SIM_AUTO_APPROVE_USD", "10")),
  simDailyCapUsd: Number(env("SIM_DAILY_CAP_USD", "50")),
};

export type Deployment = {
  network: string;
  chainId: number;
  vault: `0x${string}`;
  usdc: `0x${string}`;
  owner: `0x${string}`;
  agent: `0x${string}`;
  venue: `0x${string}`;
  sellers: `0x${string}`[];
  deployBlock: number;
};

export function loadDeployment(): Deployment {
  const p = path.join(ROOT, "contracts", "deployments", `${cfg.deployment}.json`);
  if (!fs.existsSync(p)) throw new Error(`No deployment at ${p}. Run the deploy script first, or set CHAIN_MODE=sim.`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** $12.50, $0.40, but $0.005 and $0.0125 for sub-cent data prices. */
export const usd = (n: number) => `$${n >= 0.1 || n === 0 ? n.toFixed(2) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
