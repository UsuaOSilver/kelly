// Deploys AllowanceVault. On localhost it also deploys MockUSDC and funds everything;
// on Arc it uses the real testnet USDC and the keys in ../.env.
// Plain viem rather than hardhat-viem's helpers, because those only know chains bundled with viem.
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { createPublicClient, createWalletClient, defineChain, getAddress, http, parseUnits } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const ARC_USDC = "0x3600000000000000000000000000000000000000";
// Hardhat's well-known first test account. Local chain only.
const LOCAL_OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const u = (n) => parseUnits(String(n), 6);

async function main() {
  const net = hre.network.name;
  const local = net === "localhost" || net === "hardhat";
  const url = hre.network.config.url;
  const probe = createPublicClient({ transport: http(url) });
  const chainId = await probe.getChainId();
  const chain = defineChain({
    id: chainId,
    name: net,
    nativeCurrency: local ? { name: "Ether", symbol: "ETH", decimals: 18 } : { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const pub = createPublicClient({ chain, transport: http(url) });

  const ownerKey = local ? LOCAL_OWNER_KEY : process.env.OWNER_PRIVATE_KEY;
  if (!ownerKey) throw new Error("OWNER_PRIVATE_KEY missing in .env (run `npm run keys`)");
  const owner = privateKeyToAccount(ownerKey);
  const wallet = createWalletClient({ account: owner, chain, transport: http(url) });

  const send = async (label, address, abi, functionName, args) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
    console.log(`${label.padEnd(16)}${hash}`);
    return hash;
  };
  const deploy = async (name, args = []) => {
    const art = await hre.artifacts.readArtifact(name);
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${name} deployment reverted (${hash})`);
    console.log(`${name.padEnd(16)}${r.contractAddress}  (tx ${hash})`);
    return { address: r.contractAddress, abi: art.abi, hash, block: r.blockNumber };
  };

  const autoApprove = process.env.AUTO_APPROVE_LIMIT_USDC || "10";
  const dailyCap = process.env.DAILY_CAP_USDC || "50";
  const depositAmt = local ? "200" : process.env.VAULT_DEPOSIT_USDC || "5";
  const erc20 = (await hre.artifacts.readArtifact("MockUSDC")).abi;

  let usdcAddr, agent, venue, sellers;
  if (local) {
    const accounts = await probe.request({ method: "eth_accounts" });
    const usdc = await deploy("MockUSDC");
    usdcAddr = usdc.address;
    [agent, venue] = [accounts[1], accounts[2]];
    sellers = accounts.slice(3, 6);
    await send("mint", usdcAddr, erc20, "mint", [owner.address, u(1000)]);
  } else {
    usdcAddr = ARC_USDC;
    if (!process.env.AGENT_PRIVATE_KEY || !process.env.VENUE_ADDRESS) throw new Error("AGENT_PRIVATE_KEY / VENUE_ADDRESS missing in .env (run `npm run keys`)");
    agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY).address;
    venue = getAddress(process.env.VENUE_ADDRESS);
    sellers = (process.env.SELLER_ADDRESSES || "").split(",").filter(Boolean);
  }

  const vault = await deploy("AllowanceVault", [usdcAddr, agent, u(autoApprove), u(dailyCap)]);
  const txs = { deploy: vault.hash };
  txs.allowVenue = await send("allow venue", vault.address, vault.abi, "setPayee", [venue, true]);
  // Data-budget top-ups go to the agent's own wallet. They stay inside the daily cap.
  txs.allowAgent = await send("allow agent", vault.address, vault.abi, "setPayee", [agent, true]);
  txs.approve = await send("approve USDC", usdcAddr, erc20, "approve", [vault.address, u(depositAmt)]);
  txs.deposit = await send(`deposit ${depositAmt}`, vault.address, vault.abi, "deposit", [u(depositAmt)]);

  const out = {
    network: net,
    chainId,
    vault: vault.address,
    usdc: usdcAddr,
    owner: owner.address,
    agent,
    venue,
    sellers,
    policy: { autoApproveLimitUsdc: autoApprove, dailyCapUsdc: dailyCap, depositUsdc: depositAmt },
    deployBlock: Number(vault.block),
    deployedAt: new Date().toISOString(),
    txs,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${net}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote deployments/${net}.json`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exit(1);
});
