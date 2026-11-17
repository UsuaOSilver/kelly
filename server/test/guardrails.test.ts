import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { dataPolicy, PolicyBlock, simGateway } from "../src/pay.ts";
import { memoOf, SimVault, VaultRevert, type VaultEvent } from "../src/vault.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("SimVault mirrors the contract's rules", () => {
  let events: VaultEvent[];
  let v: SimVault;
  const agent = "0x00000000000000000000000000000000000a9e17";
  beforeEach(() => {
    events = [];
    v = new SimVault(agent, (e) => events.push(e)); // defaults: $200 balance, $10 auto-approve, $50/day
  });

  it("pays small amounts immediately", async () => {
    await v.spend(v.venue, 4, memoOf("a"));
    await flush();
    expect(events.map((e) => e.name)).toEqual(["Spent"]);
    expect((await v.state()).balanceUsd).toBe(196);
  });
  it("queues large amounts until approved", async () => {
    await v.spend(v.venue, 18, memoOf("b"));
    await flush();
    expect(events[0].name).toBe("SpendRequested");
    expect((await v.state()).balanceUsd).toBe(200);
    await v.approve(events[0].requestId!);
    await flush();
    expect(events[1]).toMatchObject({ name: "Spent", ownerApproved: true, amountUsd: 18 });
    await expect(v.approve(events[0].requestId!)).rejects.toMatchObject({ errorName: "NotPending" });
  });
  it("rejects over-cap requests outright", async () => {
    await expect(v.spend(v.venue, 500, memoOf("c"))).rejects.toBeInstanceOf(VaultRevert);
    await expect(v.spend(v.venue, 500, memoOf("c"))).rejects.toMatchObject({ errorName: "DailyCapExceeded" });
  });
  it("re-checks the cap at approval time", async () => {
    await v.spend(v.venue, 45, memoOf("d"));
    await v.spend(v.venue, 10, memoOf("e"));
    await expect(v.approve("0")).rejects.toMatchObject({ errorName: "DailyCapExceeded" });
  });
  it("blocks unknown payees and honours the kill switch", async () => {
    await expect(v.spend("0x000000000000000000000000000000000000dEaD", 1, memoOf("f"))).rejects.toMatchObject({ errorName: "PayeeNotAllowed" });
    await v.setPaused(true);
    await expect(v.spend(v.venue, 1, memoOf("g"))).rejects.toMatchObject({ errorName: "IsPaused" });
  });
  it("denied requests move nothing", async () => {
    await v.spend(v.venue, 18, memoOf("h"));
    await v.deny("0");
    await expect(v.approve("0")).rejects.toMatchObject({ errorName: "NotPending" });
    expect((await v.state()).balanceUsd).toBe(200);
  });
});

describe("data-spend policy", () => {
  const seller = "0x5e11e70000000000000000000000000000000001";
  beforeEach(() => {
    dataPolicy.allowedSellers = new Set([seller]);
    dataPolicy.spentUsd = 0;
    dataPolicy.calls = 0;
  });
  it("allows a cheap call to an allowlisted seller", () => {
    expect(() => dataPolicy.check(seller, 0.005, "x")).not.toThrow();
  });
  it("blocks unknown sellers, overpriced calls and budget overruns", () => {
    expect(() => dataPolicy.check("0x000000000000000000000000000000000000dEaD", 0.001, "x")).toThrow(PolicyBlock);
    expect(() => dataPolicy.check(seller, 0.5, "x")).toThrow(/per-call limit/);
    dataPolicy.spentUsd = 0.499;
    expect(() => dataPolicy.check(seller, 0.005, "x")).toThrow(/data budget/);
  });
});

describe("sim facilitator", () => {
  const types = { Payment: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "resource", type: "string" }] } as const;
  const domain = { name: "KellySimFacilitator", version: "1", chainId: 31337 } as const;
  const to = "0x5e11e70000000000000000000000000000000002" as const;
  const sign = async (acct: ReturnType<typeof privateKeyToAccount>, nonce: `0x${string}`, value = "2000") => {
    const m = { from: acct.address, to, value: BigInt(value), nonce, resource: "http://x/r" };
    return { ...m, value, signature: await acct.signTypedData({ domain, types, primaryType: "Payment", message: m }) };
  };
  const exp = { to, value: "2000", resource: "http://x/r" };
  const n = (i: number) => `0x${String(i).padStart(64, "0")}` as `0x${string}`;

  it("settles a signed payment once, then rejects the replay", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    simGateway.credit(buyer.address, 1);
    const p = await sign(buyer, n(1));
    expect(await simGateway.settle(p, exp)).toMatchObject({ ok: true });
    expect(simGateway.balance(buyer.address)).toBeCloseTo(0.998, 9);
    expect(await simGateway.settle(p, exp)).toMatchObject({ ok: false, reason: "replayed_nonce" });
  });
  it("rejects forged signatures, tampered amounts and empty balances", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const thief = privateKeyToAccount(generatePrivateKey());
    simGateway.credit(buyer.address, 1);
    const forged = { ...(await sign(thief, n(2))), from: buyer.address };
    expect(await simGateway.settle(forged, exp)).toMatchObject({ ok: false, reason: "invalid_signature" });
    expect(await simGateway.settle(await sign(buyer, n(3), "1"), exp)).toMatchObject({ ok: false, reason: "invalid_payload" });
    expect(await simGateway.settle(await sign(thief, n(4)), exp)).toMatchObject({ ok: false, reason: "insufficient_funds" });
  });
});
