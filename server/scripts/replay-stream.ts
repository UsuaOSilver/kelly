// Local stand-in for a QuickNode Stream, for testing the webhook path without a public URL.
// It follows the chain, shapes each block like the block_with_receipts dataset, runs the REAL
// filter function from src/quicknode.ts over it, and POSTs whatever survives to the webhook.
import { createPublicClient, http } from "viem";
import { cfg, loadDeployment } from "../src/config.ts";
import { filterSource } from "../src/quicknode.ts";

const dep = loadDeployment();
const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
const main = new Function(`${filterSource(dep.vault)}; return main;`)() as (s: unknown) => unknown;
const hex = (v: unknown) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v);

let next = BigInt(process.env.FROM_BLOCK ?? dep.deployBlock);
const once = process.argv.includes("--once");
console.log(`Replaying vault ${dep.vault} from block ${next} → ${cfg.publicUrl}/webhooks/quicknode`);

for (;;) {
  const head = await pub.getBlockNumber();
  for (; next <= head; next++) {
    const block = await pub.getBlock({ blockNumber: next });
    const receipts = await Promise.all(block.transactions.map((hash) => pub.getTransactionReceipt({ hash })));
    const shaped = {
      block: { number: hex(block.number), hash: block.hash },
      receipts: receipts.map((r) => ({ transactionHash: r.transactionHash, logs: r.logs.map((l) => ({ ...l, logIndex: hex(l.logIndex), blockNumber: hex(l.blockNumber) })) })),
    };
    const out = main({ data: [shaped], metadata: { network: dep.network, dataset: "block_with_receipts" } });
    if (!out) continue;
    const r = await fetch(`${cfg.publicUrl}/webhooks/quicknode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kelly-Token": cfg.quicknodeToken },
      body: JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? hex(v) : v)),
    });
    console.log(`block ${next}: delivered ${(out as any).logs.length} log(s) → ${r.status} ${await r.text()}`);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, 1000));
}
