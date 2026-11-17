// Creates the QuickNode Stream that feeds Kelly's ledger and approval prompt.
//   network      Arc testnet
//   dataset      block_with_receipts
//   filter       keep only logs emitted by the AllowanceVault (see src/quicknode.ts)
//   destination  webhook → {PUBLIC_URL}/webhooks/quicknode, authenticated by a shared-secret header
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cfg, loadDeployment, ROOT } from "../src/config.ts";
import { filterSource } from "../src/quicknode.ts";

const apiKey = process.env.QUICKNODE_API_KEY;
if (!apiKey) throw new Error("Set QUICKNODE_API_KEY in .env (QuickNode dashboard → API Keys, with Streams permission).");
if (/localhost|127\.0\.0\.1/.test(cfg.publicUrl)) throw new Error("PUBLIC_URL must be reachable from the internet (see README → Public URL).");

const dep = loadDeployment();
const token = cfg.quicknodeToken || crypto.randomBytes(24).toString("hex");
const body = {
  name: "kelly-vault-events",
  network: process.env.QUICKNODE_NETWORK || "arc-testnet",
  dataset: "block_with_receipts",
  filter_function: Buffer.from(filterSource(dep.vault)).toString("base64"),
  region: "usa_east",
  start_range: dep.deployBlock,
  end_range: -1,
  dataset_batch_size: 1,
  include_stream_metadata: "body",
  destination: "webhook",
  fix_block_reorgs: 0,
  keep_distance_from_tip: 0,
  destination_attributes: {
    url: `${cfg.publicUrl}/webhooks/quicknode`,
    compression: "none",
    headers: { "Content-Type": "application/json", "X-Kelly-Token": token },
    max_retry: 3,
    retry_interval_sec: 1,
    post_timeout_sec: 10,
  },
  status: "active",
};

const r = await fetch("https://api.quicknode.com/streams/rest/v1/streams", {
  method: "POST",
  headers: { accept: "application/json", "Content-Type": "application/json", "x-api-key": apiKey },
  body: JSON.stringify(body),
});
const j = (await r.json().catch(() => ({}))) as any;
if (!r.ok) {
  console.error(`QuickNode rejected the stream (${r.status}):`, JSON.stringify(j, null, 2));
  console.error("If the network name is wrong, set QUICKNODE_NETWORK to the value shown in the dashboard's network picker.");
  process.exit(1);
}

const envPath = path.join(ROOT, ".env");
let env = fs.readFileSync(envPath, "utf8");
const set = (k: string, v: string) => (env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`);
set("QUICKNODE_SECURITY_TOKEN", token);
set("EVENT_SOURCE", "quicknode");
fs.writeFileSync(envPath, env);
console.log(`Stream ${j.id} is ${j.status}. Wrote QUICKNODE_SECURITY_TOKEN and EVENT_SOURCE=quicknode to .env — restart the server.`);
