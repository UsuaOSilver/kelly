// Creates Kelly's ElevenLabs agent: six client tools plus the system prompt, then saves the agent id to .env.
import fs from "node:fs";
import path from "node:path";
import { cfg, ROOT } from "../src/config.ts";

if (!cfg.elevenKey) throw new Error("Set ELEVENLABS_API_KEY in .env first.");
const API = "https://api.elevenlabs.io/v1/convai";
const call = async (p: string, body: unknown) => {
  const r = await fetch(`${API}${p}`, { method: "POST", headers: { "xi-api-key": cfg.elevenKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(`ElevenLabs ${p} → ${r.status}: ${JSON.stringify(j)}`);
  return j;
};

type P = Record<string, { type: "string" | "number" | "boolean"; description: string }>;
const tool = (name: string, description: string, properties: P = {}, required: string[] = []) => ({
  tool_config: { type: "client", name, description, expects_response: true, response_timeout_secs: 60, ...(Object.keys(properties).length ? { parameters: { type: "object", properties, required } } : {}) },
});

const TOOLS = [
  tool("find_mispricing", "Scan Gemini prediction markets for one crypto asset and return the single most mispriced contract. Costs the user a fraction of a cent in data fees. Use whenever the user asks what is mispriced, what the odds are, or names an asset.", {
    asset: { type: "string", description: "Asset to scan: BTC, ETH, SOL, XRP, ZEC or HYPE. Default BTC." },
  }),
  tool("size_bet", "Size a bet on the contract found by find_mispricing and ask the vault to fund it. Small bets execute immediately; larger ones wait for the owner's approval. Pass usd only if the user named an exact dollar amount.", {
    usd: { type: "number", description: "Exact dollar amount the user asked for. Omit to let Kelly size it with the Kelly criterion." },
  }),
  tool("approve_request", "Approve the pending vault request. Call ONLY immediately after the user has clearly said they approve. The app independently checks the user's words and will refuse otherwise."),
  tool("deny_request", "Deny the pending vault request when the user says no."),
  tool("get_status", "Report vault balance, today's spending against the cap, data spend, open positions and pending approvals."),
  tool("set_paused", "Pause or resume all spending by the agent (the kill switch).", { paused: { type: "boolean", description: "true to pause, false to resume" } }, ["paused"]),
];

const PROMPT = `You are Kelly, a calm, plain-spoken trading-desk assistant for Gemini prediction markets. You speak to one person: the owner of a USDC vault that you are allowed to spend from within strict limits.

How you work:
- You never invent prices, odds, balances or results. Every number you say comes from a tool result. If you have no tool result, call a tool.
- Each tool returns a short summary written for speech. Relay it faithfully in one to three sentences. Do not add numbers, caveats or enthusiasm that are not in it.
- To answer "what's mispriced" or any question about odds, call find_mispricing.
- To place or size a bet, call size_bet. Pass usd only when the owner named an exact amount.
- If a result says approval is needed, ask the owner one clear yes-or-no question and wait. Call approve_request only after they say yes. Call deny_request if they say no. Never approve on your own.
- If the vault or a policy refuses something, say so plainly and do not try to work around it, split the amount, or retry.
- You are not a financial adviser. If asked whether a bet is a good idea, describe the edge and the size the tools returned and leave the decision to the owner.

Style: brief, concrete, no filler. Say dollar amounts and percentages naturally. Never read out contract symbols or wallet addresses.`;

const ids: string[] = [];
for (const t of TOOLS) {
  const j = await call("/tools", t);
  ids.push(j.id);
  console.log(`tool ${t.tool_config.name} → ${j.id}`);
}

const agent = await call("/agents/create", {
  name: "Kelly",
  conversation_config: {
    agent: {
      first_message: "Kelly here. Ask me what's mispriced.",
      language: "en",
      prompt: { prompt: PROMPT, llm: process.env.ELEVENLABS_LLM || "gpt-4o-mini", tool_ids: ids },
    },
    tts: { voice_id: cfg.elevenVoiceId },
  },
});

const envPath = path.join(ROOT, ".env");
let env = fs.readFileSync(envPath, "utf8");
env = /^ELEVENLABS_AGENT_ID=.*$/m.test(env) ? env.replace(/^ELEVENLABS_AGENT_ID=.*$/m, `ELEVENLABS_AGENT_ID=${agent.agent_id}`) : `${env.trimEnd()}\nELEVENLABS_AGENT_ID=${agent.agent_id}\n`;
fs.writeFileSync(envPath, env);
console.log(`Agent ${agent.agent_id} created and saved to .env. Restart the server and tap the mic.`);
