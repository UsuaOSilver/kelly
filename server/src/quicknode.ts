// QuickNode Streams: the filter that runs on QuickNode's side, and verification of what it delivers.
import crypto from "node:crypto";
import type { Request } from "express";
import { cfg } from "./config.ts";

/**
 * Stream filter (dataset: block_with_receipts). Keeps only logs emitted by the vault,
 * so the webhook receives a few hundred bytes per relevant block and nothing otherwise.
 */
export const filterSource = (vault: string) => `function main(stream) {
  var VAULT = "${vault.toLowerCase()}";
  var items = Array.isArray(stream.data) ? stream.data : [stream.data];
  var logs = [];
  var block = null;
  for (var i = 0; i < items.length; i++) {
    var receipts = (items[i] && items[i].receipts) || [];
    if (items[i] && items[i].block) block = items[i].block.number;
    for (var r = 0; r < receipts.length; r++) {
      var ls = receipts[r].logs || [];
      for (var l = 0; l < ls.length; l++) {
        if (ls[l].address && ls[l].address.toLowerCase() === VAULT) {
          logs.push({
            address: ls[l].address,
            topics: ls[l].topics,
            data: ls[l].data,
            transactionHash: ls[l].transactionHash,
            logIndex: ls[l].logIndex,
            blockNumber: ls[l].blockNumber
          });
        }
      }
    }
  }
  return logs.length ? { block: block, logs: logs } : null;
}`;

/** HMAC-SHA256 over nonce + timestamp + body, per QuickNode's webhook signing scheme. */
export function verifyQuickNode(req: Request): boolean {
  if (!cfg.quicknodeToken) return true; // unsigned deliveries are accepted only when no token is configured (local testing)
  const nonce = req.header("x-qn-nonce") ?? "";
  const ts = req.header("x-qn-timestamp") ?? "";
  const given = req.header("x-qn-signature") ?? "";
  const body = (req as any).rawBody ? (req as any).rawBody.toString("utf8") : JSON.stringify(req.body);
  const want = crypto.createHmac("sha256", cfg.quicknodeToken).update(nonce + ts + body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(want, "hex"));
  } catch {
    return false;
  }
}
