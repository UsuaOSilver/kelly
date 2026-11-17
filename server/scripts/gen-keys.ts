// Generates fresh testnet wallets into ../.env (never committed). Prints addresses only.
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ROOT } from "../src/config.ts";

const envPath = path.join(ROOT, ".env");
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
const set = (k: string, v: string) => {
  env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
};
const ensureKey = (k: string) => {
  if (!get(k)) set(k, generatePrivateKey());
  return privateKeyToAccount(get(k) as `0x${string}`).address;
};

const owner = ensureKey("OWNER_PRIVATE_KEY");
const agent = ensureKey("AGENT_PRIVATE_KEY");
const sellers = ["SELLER_1_PRIVATE_KEY", "SELLER_2_PRIVATE_KEY", "SELLER_3_PRIVATE_KEY"].map(ensureKey);
const venue = ensureKey("VENUE_PRIVATE_KEY");
set("SELLER_ADDRESSES", sellers.join(","));
set("VENUE_ADDRESS", venue);
fs.writeFileSync(envPath, env, { mode: 0o600 });

console.log(`OWNER  (fund this: holds your USDC, deploys the vault)  ${owner}`);
console.log(`AGENT  (fund this: pays gas + nanopayments)             ${agent}`);
console.log(`VENUE  (receives trade stakes, no funding needed)       ${venue}`);
console.log(`SELLERS (receive nanopayments, no funding needed)       ${sellers.join(", ")}`);
