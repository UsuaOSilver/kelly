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

/**
 * Authenticates a delivery with a shared secret that we choose ourselves. It is accepted either as a
 * custom `X-Kelly-Token` header on the Stream's webhook destination or as `?token=` on the webhook URL
 * (for Streams created by hand in the dashboard). Compared in constant time.
 */
export function verifyQuickNode(req: Request): boolean {
  if (!cfg.quicknodeToken) return true; // open only when no token is configured (local testing)
  const given = Buffer.from(req.header("x-kelly-token") ?? String(req.query.token ?? ""));
  const want = Buffer.from(cfg.quicknodeToken);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
