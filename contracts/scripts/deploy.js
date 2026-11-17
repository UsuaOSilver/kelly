// Deploys AllowanceVault. On localhost it also deploys MockUSDC and funds everything;
// on Arc it uses the real testnet USDC and the keys in ../.env.
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { parseUnits, getAddress } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const ARC_USDC = "0x3600000000000000000000000000000000000000";
const u = (n) => parseUnits(String(n), 6);

async function main() {
  const net = hre.network.name;
  const local = net === "localhost" || net === "hardhat";
  const pub = await hre.viem.getPublicClient();
  const wallets = await hre.viem.getWalletClients();
  const owner = wallets[0];
  const wait = (hash) => pub.waitForTransactionReceipt({ hash });

  const autoApprove = process.env.AUTO_APPROVE_LIMIT_USDC || "10";
  const dailyCap = process.env.DAILY_CAP_USDC || "50";
  const depositAmt = local ? "200" : process.env.VAULT_DEPOSIT_USDC || "5";

  let usdcAddr, agent, venue, sellers;
  if (local) {
    const usdc = await hre.viem.deployContract("MockUSDC");
    usdcAddr = usdc.address;
    agent = wallets[1].account.address;
    venue = wallets[2].account.address;
    sellers = [wallets[3], wallets[4], wallets[5]].map((w) => w.account.address);
    await wait(await usdc.write.mint([owner.account.address, u(1000)]));
  } else {
    usdcAddr = ARC_USDC;
    if (!process.env.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY missing in .env");
    agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY).address;
    venue = getAddress(process.env.VENUE_ADDRESS);
    sellers = [];
  }

  const vault = await hre.viem.deployContract("AllowanceVault", [usdcAddr, agent, u(autoApprove), u(dailyCap)]);
  console.log(`AllowanceVault  ${vault.address}`);

  await wait(await vault.write.setPayee([venue, true]));
  await wait(await vault.write.setPayee([agent, true])); // data-budget top-ups, still inside the daily cap

  const usdc = await hre.viem.getContractAt("MockUSDC", usdcAddr);
  await wait(await usdc.write.approve([vault.address, u(depositAmt)]));
  await wait(await vault.write.deposit([u(depositAmt)]));
  console.log(`Deposited       ${depositAmt} USDC`);

  const out = {
    network: net,
    chainId: await pub.getChainId(),
    vault: vault.address,
    usdc: usdcAddr,
    owner: owner.account.address,
    agent,
    venue,
    sellers,
    policy: { autoApproveLimitUsdc: autoApprove, dailyCapUsdc: dailyCap },
    deployBlock: Number(await pub.getBlockNumber()),
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${net}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote deployments/${net}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
