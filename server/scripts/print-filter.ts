// Prints everything needed to create the Stream by hand in the QuickNode dashboard.
import crypto from "node:crypto";
import { cfg, loadDeployment } from "../src/config.ts";
import { filterSource } from "../src/quicknode.ts";

const dep = loadDeployment();
const token = cfg.quicknodeToken || crypto.randomBytes(24).toString("hex");
console.log(`Network:      Arc Testnet
Dataset:      Block with Receipts
Start block:  ${dep.deployBlock}   (end: none, keep running)
Destination:  Webhook
URL:          ${cfg.publicUrl}/webhooks/quicknode?token=${token}

Put this in .env, then restart the server:
QUICKNODE_SECURITY_TOKEN=${token}
EVENT_SOURCE=quicknode

Filter function (paste into "Modify the stream payload"):
────────────────────────────────────────────────────────
${filterSource(dep.vault)}`);
