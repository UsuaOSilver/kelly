# Demo video script (2:30) and live pitch

Record at 1080p with system audio on, so the judges hear Kelly. Use live mode if Arc, Gateway, the Stream and the voice agent are all running. If any one is not, say which, and let the header chips show it.

## Before recording

- Fresh server start, so the vault shows the full balance and the feed is empty.
- Ask about two or three assets off camera and pick the one with a clear edge today. Edges are real and change by the hour; sometimes Kelly correctly says there is nothing to do.
- Check the half-Kelly size lands above the $10 auto-approve limit. If it does not, lower `AUTO_APPROVE_LIMIT_USDC` before deploying, or say "put fifteen dollars on it".
- Explorer tab open on the vault address.

## Shot list

| Time | Screen | Say or do |
|---|---|---|
| 0:00–0:15 | Title, then the app | "Agents should trade prediction markets. Nobody should hand one their account. This is Kelly: it can think and it can ask, but only a contract on Arc can pay." |
| 0:15–0:40 | Tap the mic | **You:** "Kelly, what's mispriced in Bitcoin?" Let the three `paid` lines land in the feed. **Kelly** answers with the market price, her estimate and the edge. Point at the ladder chart: grey is Gemini, green is the model. |
| 0:40–0:55 | Activity feed | "That answer cost a cent and a half. Three payments to three sellers, each a fraction of a cent, settled by Circle Gateway on Arc. No gas per payment." |
| 0:55–1:20 | Mic | **You:** "Size a bet." **Kelly** gives the half-Kelly size and says it is over the limit. The amber approval card appears. "That card did not come from the agent. It came from the chain, through a QuickNode Stream filtered to this one contract." |
| 1:20–1:40 | Mic | **You:** "Approved." Feed shows `released`, then `order`. Position row appears. Switch to the explorer for two seconds: the `Spent` transaction. |
| 1:40–2:00 | Mic | **You:** "Put five hundred dollars on it." **Kelly:** "The vault refused…" Red `blocked` line. "That is not the agent being polite. The contract reverted with `DailyCapExceeded`." |
| 2:00–2:15 | Click **Pause Kelly**, then ask for anything | Kelly reports she is paused. "One switch, owner only." |
| 2:15–2:30 | Architecture diagram from the README | "Gemini for the market. Arc and Circle for the money. QuickNode for the truth about what moved. ElevenLabs for the interface. Kelly: an agent with an allowance." |

## If something fails while recording

- **Voice will not connect:** type the same lines. The typed console calls the same tools and speaks the answers.
- **Gemini unreachable:** set `GEMINI_SOURCE=fixture`. The header chip changes to "Gemini recording". Say so.
- **Arc RPC or Stream slow:** an event that is 12 seconds late is fetched over RPC and labelled `rpc-fallback`.
- **Everything is down:** `CHAIN_MODE=sim PAY_MODE=sim GEMINI_SOURCE=fixture npm run demo` runs with no network at all.

# Live pitch (5 minutes + 2 Q&A)

## Slides

1. **Kelly.** One line: a prediction-market desk you can talk to, on an allowance it cannot exceed.
2. **The problem.** Agents want to trade. A limit in the agent's own code is a promise, not a control.
3. **Live demo** (2:30). The script above, on stage. Typed fallback ready.
4. **How it works.** The architecture diagram. Three colours: what the agent can do, what the contract decides, what the human decides.
5. **Guardrails.** The safety table. Read out two rows: the agent key can only ask; the model cannot approve its own request.
6. **What is real today.** The honesty table. Judges trust the rest more after this slide.
7. **Next.** Passkey approval, third-party sellers, ERC-8004 discovery. And the ask.

## Likely questions

**Is the model any good?**
It is a sanity check, not alpha. Driftless lognormal, realised volatility, live spot. It finds a few points of edge after the spread on some strikes and often finds nothing. That is why sizing is half-Kelly and why any edge over 15 points is thrown away as a model error.

**Why would an agent pay for data that Gemini gives away?**
The raw data is free. The sellers sell work on top of it: a fair-value model, an order-book fill simulation, and odds history that Gemini's API does not serve. The point is the rail. Any quant can put a model behind a 402 and get paid per call, with no account and no API key.

**The sellers are yours. Is that a real marketplace?**
No, and the README says so. The payments are real x402; the sellers' independence is not. The agent discovers them from a catalog endpoint and would pay a stranger's endpoint the same way, if it were on the allowlist.

**What stops the LLM from just approving?**
Three things. The agent key cannot call `approve()`. The approval tool runs in the browser and checks the human's last words. And the daily cap applies to approved requests too.

**Who holds the owner key?**
In this build, the server, so that a voice "approved" can sign. That is the weakest part and it is first on the roadmap: the owner signature should come from a passkey on the owner's device.

**Why Arc?**
One asset. The agent holds USDC and that pays for gas, data and bets. Circle's nanopayments settle there, and fees are predictable enough to put a per-call price cap in policy.

**Why a Stream and not just polling?**
The order trigger has to be a fact about the chain, not the agent's opinion. A filtered Stream pushes exactly the vault's logs, in order, with backfill from the deploy block after a restart. Polling a public RPC gives none of those guarantees.

**Are the trades real?**
Paper by default, filled against Gemini's live order book at real prices and depth. Live orders are implemented behind a flag and have not been run, because there were no trading keys during the build.

**Is this legal to use?**
Gemini's prediction markets are restricted by jurisdiction and need a verified account. Kelly ships with live trading off.
