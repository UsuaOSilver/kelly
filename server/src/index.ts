import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { approve, chat, deny, init, onVaultEvent, pause, propose, scan, snapshot, status, vault, eventSource } from "./agent.ts";
import { cfg, ROOT } from "./config.ts";
import { bus, recent } from "./ledger.ts";
import { verifyQuickNode } from "./quicknode.ts";
import { recordTape, sellersRouter } from "./sellers.ts";
import { sellers } from "./agent.ts";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

await init();
app.use("/sellers", await sellersRouter(sellers));

/**
 * The tunnel exists so QuickNode can reach /webhooks. Everything that can move money or reveal state stays
 * on this machine: a request that came through a tunnel or proxy carries a forwarding header and is refused.
 * The paid /sellers endpoints stay public on purpose, since anyone may buy from them.
 */
const viaProxy = (req: express.Request) => Boolean(req.header("cf-connecting-ip") || req.header("x-forwarded-for") || req.header("x-real-ip"));
app.use(["/api", "/"], (req, res, next) => {
  if (process.env.ALLOW_REMOTE_CONTROL === "true" || !viaProxy(req) || req.path.startsWith("/webhooks") || req.originalUrl.startsWith("/sellers")) return next();
  res.status(403).json({ error: "Kelly's controls are only available on the machine running it." });
});

const tool = (fn: (body: any) => Promise<unknown>) => async (req: express.Request, res: express.Response) => res.json(await fn(req.body ?? {}));
app.post("/api/tools/scan", tool((b) => scan(b.asset)));
app.post("/api/tools/propose", tool((b) => propose({ usd: b.usd == null || b.usd === "" ? undefined : Number(b.usd), symbol: b.symbol || undefined, side: b.side || undefined })));
app.post("/api/tools/approve", tool((b) => approve(b.requestId)));
app.post("/api/tools/deny", tool((b) => deny(b.requestId)));
app.post("/api/tools/pause", tool((b) => pause(b.on !== false)));
app.post("/api/tools/status", tool(() => status()));
app.post("/api/chat", tool((b) => chat(String(b.text ?? ""))));

app.get("/api/state", async (_req, res) => res.json({ ...(await snapshot()), ledger: recent() }));
app.get("/api/config", (_req, res) => res.json({ elevenAgentId: cfg.elevenAgentId, hasElevenKey: Boolean(cfg.elevenKey) }));

app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const onEntry = (e: unknown) => res.write(`event: entry\ndata: ${JSON.stringify(e)}\n\n`);
  const onState = () => res.write(`event: state\ndata: {}\n\n`);
  bus.on("entry", onEntry);
  bus.on("state", onState);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("entry", onEntry);
    bus.off("state", onState);
  });
});

/** Text-to-speech for the typed console, proxied so the API key never reaches the browser. */
app.post("/api/tts", async (req, res) => {
  if (!cfg.elevenKey) return void res.status(501).json({ error: "ELEVENLABS_API_KEY not set" });
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": cfg.elevenKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text: String(req.body?.text ?? "").slice(0, 800), model_id: "eleven_flash_v2_5" }),
  });
  if (!r.ok) return void res.status(502).json({ error: `ElevenLabs ${r.status}` });
  res.set("Content-Type", "audio/mpeg").send(Buffer.from(await r.arrayBuffer()));
});

/** Signed-URL handoff so a private ElevenLabs agent can be used without exposing the key. */
app.get("/api/eleven/signed-url", async (_req, res) => {
  if (!cfg.elevenKey || !cfg.elevenAgentId) return void res.status(501).json({ error: "ElevenLabs not configured" });
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${cfg.elevenAgentId}`, { headers: { "xi-api-key": cfg.elevenKey } });
  res.status(r.status).json(await r.json());
});

/** QuickNode Streams destination. The Stream's filter has already reduced each block to this vault's logs. */
app.post("/webhooks/quicknode", (req, res) => {
  if (!verifyQuickNode(req)) return void res.status(401).json({ error: "bad token" });
  const batches = Array.isArray(req.body) ? req.body : [req.body];
  let n = 0;
  for (const b of batches) {
    const logs = b?.logs ?? b?.data?.logs ?? [];
    for (const e of vault.decode?.(logs, "quicknode") ?? []) {
      onVaultEvent(e);
      n++;
    }
  }
  res.json({ ok: true, events: n });
});

const dist = path.join(ROOT, "web", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|sellers|webhooks).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(cfg.port, "0.0.0.0", (err?: Error) => {
  if (err) {
    console.error(`Could not listen on ${cfg.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Kelly  http://localhost:${cfg.port}`);
  console.log(`  chain=${cfg.chainMode}  pay=${cfg.payMode}  events=${eventSource}  gemini=${cfg.geminiSource}  vault=${vault.address}`);
  const tick = () => recordTape().catch(() => {});
  tick();
  setInterval(tick, 60_000);
});
