const assert = require("node:assert/strict");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { keccak256, toHex, getAddress } = require("viem");

const USDC = (n) => BigInt(Math.round(n * 1e6));
const memo = (s) => keccak256(toHex(s));
const NO_REQUEST = 2n ** 256n - 1n;

async function setup() {
  const [owner, agent, venue, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUSDC");
  // auto-approve up to 10 USDC, hard cap 50 USDC/day
  const vault = await hre.viem.deployContract("AllowanceVault", [
    usdc.address,
    agent.account.address,
    USDC(10),
    USDC(50),
  ]);
  await usdc.write.mint([owner.account.address, USDC(1000)]);
  await usdc.write.approve([vault.address, USDC(1000)]);
  await vault.write.deposit([USDC(200)]);
  await vault.write.setPayee([venue.account.address, true]);
  const as = (w) => hre.viem.getContractAt("AllowanceVault", vault.address, { client: { wallet: w } });
  return { owner, agent, venue, stranger, usdc, vault, asAgent: await as(agent), asStranger: await as(stranger) };
}

describe("AllowanceVault", () => {
  it("pays small amounts immediately and logs Spent", async () => {
    const { venue, usdc, asAgent, vault } = await setup();
    await asAgent.write.spend([venue.account.address, USDC(4), memo("t1")]);
    assert.equal(await usdc.read.balanceOf([venue.account.address]), USDC(4));
    assert.equal(await vault.read.spentToday(), USDC(4));
    const [ev] = await vault.getEvents.Spent();
    assert.equal(ev.args.to, getAddress(venue.account.address));
    assert.equal(ev.args.amount, USDC(4));
    assert.equal(ev.args.requestId, NO_REQUEST);
    assert.equal(ev.args.ownerApproved, false);
  });

  it("queues large amounts until the owner approves", async () => {
    const { venue, usdc, asAgent, vault } = await setup();
    await asAgent.write.spend([venue.account.address, USDC(18), memo("big")]);
    const [req] = await vault.getEvents.SpendRequested();
    assert.equal(req.args.requestId, 0n);
    assert.equal(await usdc.read.balanceOf([venue.account.address]), 0n, "nothing moves before approval");
    await vault.write.approve([0n]);
    assert.equal(await usdc.read.balanceOf([venue.account.address]), USDC(18));
    const [ev] = await vault.getEvents.Spent();
    assert.equal(ev.args.ownerApproved, true);
    await assert.rejects(vault.write.approve([0n]), /NotPending/);
  });

  it("lets the owner deny, and denied requests cannot be approved", async () => {
    const { venue, usdc, asAgent, vault } = await setup();
    await asAgent.write.spend([venue.account.address, USDC(18), memo("big")]);
    await vault.write.deny([0n]);
    await assert.rejects(vault.write.approve([0n]), /NotPending/);
    assert.equal(await usdc.read.balanceOf([venue.account.address]), 0n);
  });

  it("rejects anything over the daily cap, even as a request", async () => {
    const { venue, asAgent, vault } = await setup();
    await assert.rejects(asAgent.write.spend([venue.account.address, USDC(500), memo("yolo")]), /DailyCapExceeded/);
    assert.equal(await vault.read.requestCount(), 0n);
  });

  it("enforces the daily cap across payments and resets the next day", async () => {
    const { venue, asAgent, vault } = await setup();
    for (let i = 0; i < 5; i++) await asAgent.write.spend([venue.account.address, USDC(10), memo(`p${i}`)]);
    assert.equal(await vault.read.remainingToday(), 0n);
    await assert.rejects(asAgent.write.spend([venue.account.address, USDC(1), memo("over")]), /DailyCapExceeded/);
    await time.increase(24 * 60 * 60);
    await asAgent.write.spend([venue.account.address, USDC(1), memo("tomorrow")]);
    assert.equal(await vault.read.spentToday(), USDC(1));
  });

  it("re-checks the cap at approval time", async () => {
    const { venue, asAgent, vault } = await setup();
    await asAgent.write.spend([venue.account.address, USDC(45), memo("a")]); // pending
    await asAgent.write.spend([venue.account.address, USDC(10), memo("b")]); // paid now
    await assert.rejects(vault.write.approve([0n]), /DailyCapExceeded/);
  });

  it("blocks payees that are not allowlisted", async () => {
    const { stranger, asAgent } = await setup();
    await assert.rejects(asAgent.write.spend([stranger.account.address, USDC(1), memo("x")]), /PayeeNotAllowed/);
  });

  it("only the agent can spend; only the owner can approve, withdraw or change policy", async () => {
    const { venue, asAgent, asStranger } = await setup();
    await assert.rejects(asStranger.write.spend([venue.account.address, USDC(1), memo("x")]), /NotAgent/);
    await asAgent.write.spend([venue.account.address, USDC(20), memo("big")]);
    await assert.rejects(asAgent.write.approve([0n]), /NotOwner/);
    await assert.rejects(asAgent.write.setPolicy([USDC(1000), USDC(1000)]), /NotOwner/);
    await assert.rejects(asAgent.write.setPayee([asAgent.address, true]), /NotOwner/);
    await assert.rejects(asAgent.write.withdraw([venue.account.address, USDC(1)]), /NotOwner/);
  });

  it("kill switch stops spending and approvals", async () => {
    const { venue, asAgent, vault } = await setup();
    await asAgent.write.spend([venue.account.address, USDC(20), memo("big")]);
    await vault.write.setPaused([true]);
    await assert.rejects(asAgent.write.spend([venue.account.address, USDC(1), memo("x")]), /IsPaused/);
    await assert.rejects(vault.write.approve([0n]), /IsPaused/);
    await vault.write.setPaused([false]);
    await vault.write.approve([0n]);
  });

  it("expires stale requests", async () => {
    const { venue, asAgent, vault } = await setup();
    await asAgent.write.spend([venue.account.address, USDC(20), memo("big")]);
    await time.increase(3601);
    await assert.rejects(vault.write.approve([0n]), /RequestExpired/);
  });
});
