# Submission package

## Devpost form choices

| Field | Choice |
|---|---|
| Main track | **Agentic Payments and AI** |
| Chain award | **Best use of Arc** |
| Bounties | **Gemini Prediction Markets**, **QuickNode Streams**, **ElevenLabs** |
| Grok Bot | Do not enter. Grok Bot is not part of the product. |

Only tick Arc, QuickNode and ElevenLabs once each is running for real (see the checklist). Entering a bounty with a simulated integration will not survive a sponsor's review.

## Written answers

**Project name:** Kelly

**Short description:** A prediction-market desk you can talk to, on a USDC allowance it cannot exceed.

**What did you build?**
Kelly is a voice agent that trades Gemini prediction markets with money it does not control. You ask what is mispriced. Kelly buys three signals from x402 sellers for about a cent in total, compares Gemini's odds with a volatility model, sizes the bet with the Kelly criterion, and asks a vault contract on Arc for the stake. The vault pays small amounts, holds larger ones until you approve, and reverts anything over the daily cap.

**What problem does it solve?**
Agents are the natural users of prediction markets, but giving one a funded account is reckless. Limits written in the agent's own code are only as reliable as the agent. Kelly moves the limits into a contract the agent cannot change, and makes the human approval a spoken "approved" instead of a wallet popup.

**How does it work?**
An ElevenLabs agent handles speech and calls six client tools. The server runs a nine-step loop: discover markets on Gemini, top up a data budget from the vault, pay per request for fair value, fill depth and odds history through Circle Gateway nanopayments, rank strikes by edge after the spread, size with half-Kelly, and call `vault.spend()`. A QuickNode Stream filtered to the vault's logs pushes each event to a webhook. The order is placed only when the `Spent` event arrives.

**What makes it unique?**
- The agent's key can do one thing onchain: ask. It cannot approve, withdraw or change policy.
- The data-spend policy runs inside Circle's pre-signing hook, so an over-limit payment is never signed.
- The language model cannot approve its own request. The browser checks the human's actual words.
- Kelly distrusts itself: any edge over 15 points is treated as a model error.
- The app labels, live, which parts are real and which are simulated.

**What would you build next?**
Passkey approval on the owner's phone so no server holds the owner key. An implied-volatility fit across the ladder. Seller discovery and reputation through Arc's ERC-8004 registries. Third-party sellers.

**Technologies:** Arc testnet, Solidity, Hardhat, Circle Gateway nanopayments (`@circle-fin/x402-batching`), x402, Gemini Prediction Markets API, QuickNode Streams, ElevenLabs Agents and TTS, viem, Node, Express, React, Vite.

## Checklist against "What to Submit"

| Requirement | State |
|---|---|
| Project name, description, team members | Ready above. Add your name. |
| Main track, chain award, bounties | Table above |
| Five written answers | Ready above |
| Technologies and sponsor tools | Ready above |
| Public GitHub repo created during the hackathon | **To do:** create the repo and push. First commit is dated Nov 16. |
| Working demo or deployed app | Runs locally with `npm run setup && npm run demo`. **To do:** deploy, or state that the demo is local plus video. |
| 2–3 minute video on YouTube or Drive | **To do:** record from `docs/DEMO.md`. Check the link opens in a private window. |
| README with technical docs and architecture | Done |
| Track: agent executes onchain transactions or reads the chain | Done on a local chain. **To do on Arc.** |
| Track: document the decision loop and safety limits | Done, README |
| Arc: core onchain functionality on Arc | **To do:** `npm run deploy:arc` |
| Arc: contract addresses and how Arc is used, in README | **To do:** paste the vault address into the README table |
| ElevenLabs: API or SDK as a core feature | Code done. **To do:** create the agent |
| ElevenLabs: video shows it working, with audio | **To do** |
| ElevenLabs: README says which products and how | Done |
| Gemini: uses the Prediction Markets API | Done, live |
| QuickNode: Streams as a core data source | Code done. **To do:** create the Stream |
| QuickNode: one Stream with a filter and a destination | **To do:** `npm run quicknode:setup` |
| QuickNode: README explains network, dataset, filter, destination, why | Done |
| In person at the closing ceremony | Required for any prize |

## Before you submit

1. Update the "Status of this build" note and the "What is real" table in the README to match what you actually switched on.
2. Paste the Arc vault address and one explorer link to a `Spent` transaction into the README.
3. Run `npm test` and `npm run smoke` one last time.
4. Submit by **Friday Nov 20, 10:00 AM CST**. The deadline is noon; leave room.
