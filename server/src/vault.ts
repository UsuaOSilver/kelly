// The agent's bank. Two implementations behind one interface:
//   rpc — the real AllowanceVault contract (local Hardhat node or Arc testnet)
//   sim — an in-memory mirror of the same rules, for a demo that cannot fail on stage
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toHex,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cfg, loadDeployment } from "./config.ts";

export const VAULT_ABI = parseAbi([
  "function spend(address to, uint256 amount, bytes32 memo) returns (uint256)",
  "function approve(uint256 requestId)",
  "function deny(uint256 requestId)",
  "function setPaused(bool paused)",
  "function setPolicy(uint256 autoApproveLimit, uint256 dailyCap)",
  "function autoApproveLimit() view returns (uint256)",
  "function dailyCap() view returns (uint256)",
  "function spentToday() view returns (uint256)",
  "function remainingToday() view returns (uint256)",
  "function paused() view returns (bool)",
  "function allowedPayee(address) view returns (bool)",
  "event Spent(address indexed to, uint256 amount, bytes32 indexed memo, uint256 requestId, bool ownerApproved)",
  "event SpendRequested(uint256 indexed requestId, address indexed to, uint256 amount, bytes32 indexed memo)",
  "event SpendDenied(uint256 indexed requestId)",
  "event PolicyUpdated(uint256 autoApproveLimit, uint256 dailyCap)",
  "event PausedSet(bool paused)",
  "event Deposited(address indexed from, uint256 amount)",
  "error NotOwner()",
  "error NotAgent()",
  "error IsPaused()",
  "error PayeeNotAllowed(address to)",
  "error DailyCapExceeded(uint256 wouldSpend, uint256 cap)",
  "error ZeroAmount()",
  "error NotPending(uint256 requestId)",
  "error RequestExpired(uint256 requestId)",
  "error TransferFailed()",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export const memoOf = (s: string): Hex => keccak256(toHex(s));
const toUnits = (usd: number) => parseUnits(usd.toFixed(6), 6);
const toUsd = (v: bigint) => Number(formatUnits(v, 6));

export type VaultEvent = {
  name: "Spent" | "SpendRequested" | "SpendDenied" | "PausedSet" | "PolicyUpdated";
  to?: string;
  amountUsd?: number;
  memo?: string;
  requestId?: string;
  ownerApproved?: boolean;
  paused?: boolean;
  tx: string;
  logIndex: number;
  source: string;
};

export type VaultState = {
  mode: "sim" | "rpc";
  address: string;
  network: string;
  balanceUsd: number;
  autoApproveUsd: number;
  dailyCapUsd: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  paused: boolean;
};

/** A guardrail refusal, carrying the contract's own error name. */
export class VaultRevert extends Error {
  constructor(public errorName: string, public human: string) {
    super(`${errorName}: ${human}`);
  }
}

export interface Vault {
  readonly mode: "sim" | "rpc";
  readonly address: string;
  readonly agent: string;
  readonly venue: string;
  state(): Promise<VaultState>;
  spend(to: string, usd: number, memo: Hex): Promise<{ tx: string }>;
  approve(requestId: string): Promise<{ tx: string }>;
  deny(requestId: string): Promise<{ tx: string }>;
  setPaused(p: boolean): Promise<{ tx: string }>;
  /** rpc only: pull logs since the last poll. */
  poll?(source: string): Promise<VaultEvent[]>;
  decode?(logs: { address: string; topics: Hex[]; data: Hex; transactionHash: string; logIndex: number | string }[], source: string): VaultEvent[];
}

function humanize(name: string, args: readonly unknown[] = []): string {
  switch (name) {
    case "DailyCapExceeded":
      return `that would bring today's spending to $${toUsd(args[0] as bigint).toFixed(2)}, over the $${toUsd(args[1] as bigint).toFixed(2)} daily cap`;
    case "PayeeNotAllowed":
      return `${args[0]} is not on the vault's payee allowlist`;
    case "IsPaused":
      return "the vault is paused";
    case "NotPending":
      return "that request is no longer pending";
    case "RequestExpired":
      return "that request expired";
    default:
      return name;
  }
}

// ─────────────────────────────── sim ───────────────────────────────

export class SimVault implements Vault {
  readonly mode = "sim" as const;
  readonly address = "0x51A0000000000000000000000000000000005afe";
  readonly venue = "0x51A000000000000000000000000000000000beef";
  private balance = cfg.simVaultUsd;
  private autoApprove = cfg.simAutoApproveUsd;
  private dailyCap = cfg.simDailyCapUsd;
  private spent = 0;
  private day = Math.floor(Date.now() / 86400_000);
  private paused = false;
  private allowed: Set<string>;
  private requests: { to: string; usd: number; memo: Hex; createdAt: number; status: "pending" | "executed" | "denied" }[] = [];
  private nonce = 0;

  constructor(readonly agent: string, private emit: (e: VaultEvent) => void) {
    this.allowed = new Set([this.venue.toLowerCase(), agent.toLowerCase()]);
  }

  private tx() {
    return keccak256(toHex(`sim-tx-${++this.nonce}-${Date.now()}`));
  }
  private spentToday() {
    const d = Math.floor(Date.now() / 86400_000);
    if (d !== this.day) [this.day, this.spent] = [d, 0];
    return this.spent;
  }
  private checkCap(usd: number) {
    const would = this.spentToday() + usd;
    if (would > this.dailyCap + 1e-9) throw new VaultRevert("DailyCapExceeded", humanize("DailyCapExceeded", [toUnits(would), toUnits(this.dailyCap)]));
  }
  private pay(usd: number) {
    this.spentToday();
    this.spent += usd;
    this.balance -= usd;
  }

  async state(): Promise<VaultState> {
    const spentTodayUsd = this.spentToday();
    return {
      mode: "sim",
      address: this.address,
      network: "simulated",
      balanceUsd: this.balance,
      autoApproveUsd: this.autoApprove,
      dailyCapUsd: this.dailyCap,
      spentTodayUsd,
      remainingTodayUsd: Math.max(0, this.dailyCap - spentTodayUsd),
      paused: this.paused,
    };
  }

  async spend(to: string, usd: number, memo: Hex) {
    if (this.paused) throw new VaultRevert("IsPaused", humanize("IsPaused"));
    if (usd <= 0) throw new VaultRevert("ZeroAmount", "amount is zero");
    if (!this.allowed.has(to.toLowerCase())) throw new VaultRevert("PayeeNotAllowed", humanize("PayeeNotAllowed", [to]));
    this.checkCap(usd);
    const tx = this.tx();
    if (usd <= this.autoApprove) {
      this.pay(usd);
      queueMicrotask(() => this.emit({ name: "Spent", to, amountUsd: usd, memo, requestId: undefined, ownerApproved: false, tx, logIndex: 0, source: "sim" }));
    } else {
      const id = String(this.requests.push({ to, usd, memo, createdAt: Date.now(), status: "pending" }) - 1);
      queueMicrotask(() => this.emit({ name: "SpendRequested", to, amountUsd: usd, memo, requestId: id, tx, logIndex: 0, source: "sim" }));
    }
    return { tx };
  }

  async approve(requestId: string) {
    const r = this.requests[Number(requestId)];
    if (!r || r.status !== "pending") throw new VaultRevert("NotPending", humanize("NotPending"));
    if (Date.now() > r.createdAt + 3600_000) throw new VaultRevert("RequestExpired", humanize("RequestExpired"));
    if (this.paused) throw new VaultRevert("IsPaused", humanize("IsPaused"));
    this.checkCap(r.usd);
    r.status = "executed";
    this.pay(r.usd);
    const tx = this.tx();
    queueMicrotask(() => this.emit({ name: "Spent", to: r.to, amountUsd: r.usd, memo: r.memo, requestId, ownerApproved: true, tx, logIndex: 0, source: "sim" }));
    return { tx };
  }

  async deny(requestId: string) {
    const r = this.requests[Number(requestId)];
    if (!r || r.status !== "pending") throw new VaultRevert("NotPending", humanize("NotPending"));
    r.status = "denied";
    const tx = this.tx();
    queueMicrotask(() => this.emit({ name: "SpendDenied", requestId, tx, logIndex: 0, source: "sim" }));
    return { tx };
  }

  async setPaused(p: boolean) {
    this.paused = p;
    const tx = this.tx();
    queueMicrotask(() => this.emit({ name: "PausedSet", paused: p, tx, logIndex: 0, source: "sim" }));
    return { tx };
  }
}

// ─────────────────────────────── rpc ───────────────────────────────

export class RpcVault implements Vault {
  readonly mode = "rpc" as const;
  private dep = loadDeployment();
  readonly address = this.dep.vault;
  readonly venue = this.dep.venue;
  private pub = createPublicClient({ transport: http(cfg.rpcUrl) });
  private agentAcct = privateKeyToAccount(cfg.agentKey as Hex);
  private ownerAcct = privateKeyToAccount(cfg.ownerKey as Hex);
  readonly agent = this.agentAcct.address;
  private agentWallet = createWalletClient({ account: this.agentAcct, transport: http(cfg.rpcUrl) });
  private ownerWallet = createWalletClient({ account: this.ownerAcct, transport: http(cfg.rpcUrl) });
  private lastBlock = BigInt(this.dep.deployBlock);
  private chain: any;

  private async getChain() {
    if (!this.chain) {
      const id = await this.pub.getChainId();
      this.chain = { id, name: this.dep.network, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
    }
    return this.chain;
  }

  private async write(who: "agent" | "owner", functionName: any, args: any[]) {
    const account = who === "agent" ? this.agentAcct : this.ownerAcct;
    const wallet = who === "agent" ? this.agentWallet : this.ownerWallet;
    try {
      // Simulate first so a guardrail refusal surfaces as a decoded custom error, without spending gas.
      const { request } = await this.pub.simulateContract({ address: this.address, abi: VAULT_ABI, functionName, args, account, chain: await this.getChain() } as any);
      const tx = await wallet.writeContract(request as any);
      await this.pub.waitForTransactionReceipt({ hash: tx });
      return { tx };
    } catch (e) {
      if (e instanceof BaseError) {
        const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
        const name = r?.data?.errorName;
        if (name) throw new VaultRevert(name, humanize(name, r!.data!.args ?? []));
      }
      throw e;
    }
  }

  async state(): Promise<VaultState> {
    const c = { address: this.address, abi: VAULT_ABI } as const;
    const [bal, auto, cap, spent, remaining, paused] = await Promise.all([
      this.pub.readContract({ address: this.dep.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [this.address] }),
      this.pub.readContract({ ...c, functionName: "autoApproveLimit" }),
      this.pub.readContract({ ...c, functionName: "dailyCap" }),
      this.pub.readContract({ ...c, functionName: "spentToday" }),
      this.pub.readContract({ ...c, functionName: "remainingToday" }),
      this.pub.readContract({ ...c, functionName: "paused" }),
    ]);
    return {
      mode: "rpc",
      address: this.address,
      network: this.dep.network,
      balanceUsd: toUsd(bal),
      autoApproveUsd: toUsd(auto),
      dailyCapUsd: toUsd(cap),
      spentTodayUsd: toUsd(spent),
      remainingTodayUsd: toUsd(remaining),
      paused,
    };
  }

  spend = (to: string, usd: number, memo: Hex) => this.write("agent", "spend", [to, toUnits(usd), memo]);
  approve = (id: string) => this.write("owner", "approve", [BigInt(id)]);
  deny = (id: string) => this.write("owner", "deny", [BigInt(id)]);
  setPaused = (p: boolean) => this.write("owner", "setPaused", [p]);

  decode(logs: { address: string; topics: Hex[]; data: Hex; transactionHash: string; logIndex: number | string }[], source: string): VaultEvent[] {
    const out: VaultEvent[] = [];
    for (const l of logs) {
      if (l.address.toLowerCase() !== this.address.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: VAULT_ABI, topics: l.topics as any, data: l.data }) as any;
        const base = { tx: l.transactionHash, logIndex: Number(l.logIndex), source };
        if (d.eventName === "Spent") {
          const viaRequest = d.args.requestId !== 2n ** 256n - 1n;
          out.push({ ...base, name: "Spent", to: d.args.to, amountUsd: toUsd(d.args.amount), memo: d.args.memo, requestId: viaRequest ? String(d.args.requestId) : undefined, ownerApproved: d.args.ownerApproved });
        } else if (d.eventName === "SpendRequested") {
          out.push({ ...base, name: "SpendRequested", to: d.args.to, amountUsd: toUsd(d.args.amount), memo: d.args.memo, requestId: String(d.args.requestId) });
        } else if (d.eventName === "SpendDenied") out.push({ ...base, name: "SpendDenied", requestId: String(d.args.requestId) });
        else if (d.eventName === "PausedSet") out.push({ ...base, name: "PausedSet", paused: d.args.paused });
      } catch {
        /* not one of ours */
      }
    }
    return out;
  }

  async poll(source: string): Promise<VaultEvent[]> {
    const head = await this.pub.getBlockNumber();
    if (head <= this.lastBlock) return [];
    const from = this.lastBlock + 1n;
    // Public RPCs cap getLogs ranges; after a long pause just catch up from near the tip.
    const start = head - from > 5000n ? head - 5000n : from;
    const logs = (await this.pub.getLogs({ address: this.address, fromBlock: start, toBlock: head })) as Log[];
    this.lastBlock = head;
    return this.decode(logs as any, source);
  }
}
