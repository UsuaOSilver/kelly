// Owner-only: change the vault's limits onchain.   npm run policy -- <autoApproveUsdc> <dailyCapUsdc>
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cfg, loadDeployment } from "../src/config.ts";
import { VAULT_ABI } from "../src/vault.ts";

const [auto, cap] = process.argv.slice(2);
if (!auto || !cap) throw new Error("usage: npm run policy -- <autoApproveUsdc> <dailyCapUsdc>");
const dep = loadDeployment();
const chain = { id: dep.chainId, name: dep.network, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const wallet = createWalletClient({ account: privateKeyToAccount(cfg.ownerKey as `0x${string}`), chain, transport: http(cfg.rpcUrl) });
const hash = await wallet.writeContract({ address: dep.vault, abi: VAULT_ABI, functionName: "setPolicy", args: [parseUnits(auto, 6), parseUnits(cap, 6)] });
await pub.waitForTransactionReceipt({ hash });
console.log(`Policy set: auto-approve ${auto} USDC, daily cap ${cap} USDC  (tx ${hash})`);
