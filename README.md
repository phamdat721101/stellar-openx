<div align="center">

# 🪐 OpenX-S

### The AI-Agent Marketplace, native to Stellar

**Type a task → pay per call → get the answer in seconds.**

*Four payment rails, one wallet — USDC-settled, MoneyGram-cashable, ZK-private, escrow-protected.*

[![Live API](https://img.shields.io/badge/testnet-live-emerald)](https://api.18-143-233-99.sslip.io/health)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-black)](https://developers.stellar.org)
[![MoneyGram](https://img.shields.io/badge/MoneyGram-Ramps-orange)](https://developer.moneygram.com/)
[![ZK](https://img.shields.io/badge/ZK-Groth16-purple)](./packages/circuits/prove_hire.circom)
[![Escrow](https://img.shields.io/badge/Escrow-Trustless%20Work-amber)](https://trustlesswork.com)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## 🎯 What is OpenX-S?

A **per-task AI-agent marketplace** where sellers publish an assistant once and buyers hire it per call, settling in **USDC or MGUSD on Stellar** — ~5 s finality, ~$0.0001 fee.

No subscriptions. No card processors. No middlemen. Just wallet → task → answer.

|  | Buyer | Seller |
|---|---|---|
| **Flow** | type task → concierge ranks agents → pick a tier → sign → answer in 30–60 s | one form → wallet signs mint → agent live in <15 s |
| **Take** | pays per call (USDC / MGUSD) | keeps **95 %** of every call |
| **Signatures** | 0–4 depending on tier (see below) | 1 to publish |

---

## 🌟 Why Stellar-native?

OpenX-S is built on Stellar's canonical primitives — not adapted from another chain. Every payment rail below maps 1-to-1 to a documented Stellar building block.

| Stellar primitive | Where OpenX-S uses it |
|---|---|
| **Soroban Rust contracts** — 5 s finality, `token::transfer` SAC calls | 4 in-house contracts (`agent-registry`, `paywall-router`, `paid-call-ledger`, `budget-vault`) |
| **Stellar Asset Contract (SEP-41 SAC)** | Multi-asset settlement: USDC (Circle) + MGUSD (M0) both routed through the same paywall |
| **[MPP Session](https://developers.stellar.org/docs/build/agentic-payments/mpp/channel-guide)** — one-way payment channel Soroban contract | `budget-vault` is a byte-identical MPP-Session implementation: one deposit funds many off-chain-relayed hires |
| **SEP-24 anchor deposits** | MoneyGram Ramps → MGUSD → vault in one flow |
| **SEP-41 confidential-token wrapper** *(roadmap)* | Complementary to our ZK Groth16 privacy tier |
| **Native XLM ~$0.0001 fee** | Every 402 challenge + hire fits under a cent of network cost |

---

## 💳 Four payment rails, one wallet

|  | 🌐 **Public** | 🕶️ **Private** | 🛡️ **Escrow** | 💰 **Budget** |
|---|:---:|:---:|:---:|:---:|
| **Rate** | 1.0× | 1.5× | 2.0× | 1.0× **+ 4–8% APY** |
| **Settles via** | `paywall-router` (multi-asset) | Privacy Pool + Groth16 ZK proof | Trustless Work escrow contract | `budget-vault` (deposit-once) |
| **Wallet signatures** | 1 | 1 + 1 ZK proof | 4 (deploy, fund, approve, release) | **0 per hire** (1 upfront deposit) |
| **Counterparty on-chain?** | ✅ visible | ❌ hidden | ✅ visible | ✅ visible |
| **Buyer approval gate?** | ❌ instant | ❌ instant | ✅ buyer signs release | ❌ instant |
| **Assets** | USDC · MGUSD | USDC | USDC | USDC · MGUSD |
| **Best for** | microtasks $0.05–$1 | privacy-sensitive | high-value $5+ | 10–50 hires/month workflows |

**Every tier settles on Stellar mainnet-ready Soroban contracts.** Buyers pick the rail at hire-time via a header (`X-PAYMENT-MODE` / `X-BUDGET-VAULT`) — the frontend surfaces it as a toggle.

---

## 💵 MoneyGram rails — cash in, cash out

OpenX-S ships **MoneyGram Ramps SEP-24 integration on day one**. That means real fiat, at real retail locations, in and out of your vault.

```
        ┌───────────────────┐              ┌─────────────────┐
        │ MoneyGram store   │──cash───▶ SEP-24 anchor ──▶ MGUSD SAC ──▶ BudgetVault
        │ (500K locations,  │                                       (deposit-once)
        │  200+ countries)  │                                            │
        └───────────────────┘                                            │
                                                                         ▼
                                                                   hire agents
                                                                         │
                                                                         ▼
              seller receives 95% MGUSD ──▶ MoneyGram anchor withdraw ──▶ 💵 cash
```

**Why this matters for the seller.** A translator in Ho Chi Minh City can publish an agent, receive MGUSD earnings from a buyer in Berlin, and withdraw physical cash at their neighborhood MoneyGram agent — with **no bank, no exchange, no KYC-per-payment overhead**. The dollar-value asset itself is the on-ramp *and* the off-ramp.

**Why this matters for the buyer.** A Vietnamese SMB owner can deposit $50 cash into a BudgetVault at a MoneyGram store, then hire 40 agents that month — all with **zero wallet signatures per hire** and idle balance earning yield in the background.

| MoneyGram surface | Where it lives in OpenX-S |
|---|---|
| **SEP-24 anchor client** | [`packages/api/src/services/stellar/anchorOnramp.ts`](./packages/api/src/services/stellar/anchorOnramp.ts) |
| **MGUSD SAC (M0 testnet · TMGUSD)** | [`CCWJCHDL…M7HM`](https://stellar.expert/explorer/testnet/contract/CCWJCHDLXEIMXODO5JFZLRUM7AMA7EI2NBRBL44ROCL6WH44W22NM7HM) |
| **MGUSD SAC (M0 mainnet)** | [`CDK2LDSY…WCJA`](https://stellar.expert/explorer/public/contract/CDK2LDSYUKPEFN3HNE7K7ETUT3VIOBHSOXAK5CTO4A4RKKZQUCAIWCJA) |
| **Reference partner** | [MoneyGram Digital Assets — developer.moneygram.com](https://developer.moneygram.com/) |

---

## 🛡️ Trustless Escrow — for high-value hires

For hires above $5 (audits, code reviews, expert Q&A), buyer and seller both want the same guarantee: **funds locked until the answer is delivered and approved, arbitrator only if things go wrong**. That's exactly what Trustless Work provides — as a Soroban-native, non-custodial escrow-as-a-service.

**Non-custodial by design.** OpenX platform is the *arbitrator*, never the custodian. Funds sit in a **fresh Soroban contract minted per hire** — the buyer signs deploy + fund; the seller can only receive on buyer-signed release (or platform-signed resolution after 24 h idle + dispute).

| Role | Who holds the key | What they can sign |
|---|---|---|
| 👤 **Payer / Approver / Release signer** | Buyer's wallet | Deploy · Fund · Approve+Release · Dispute |
| 🎨 **Receiver / Service provider** | Seller's wallet | Claim-overdue (after 24 h) |
| 🏛️ **Arbitrator** | OpenX platform key | Dispute-resolution only |

**Lifecycle:**

```
① buyer signs DEPLOY   →  Trustless Work mints a fresh escrow Soroban contract
② buyer signs FUND     →  USDC locked in escrow
③ agent DELIVERS       →  gate verifies funded state, marks answered
④ buyer signs APPROVE + RELEASE  →  USDC → seller (95%) + platform (5%)
              OR
   buyer signs DISPUTE →  frozen, platform arbitrator reviews
              OR
   24 h idle           →  seller claims via dispute-then-auto-resolve
```

**Self-healing state.** `GET /v3/marketplace/escrow/me` reads the escrow's live USDC balance via Soroban SAC on every call. If balance goes to 0, the DB auto-transitions the row to `released` / `resolved` — no stuck escrows, ever.

**One page, both sides.** `/studio` shows the buyer's inbox (`Approve & release` / `Dispute` buttons) *and* the seller's queue (`Sync` / `Claim overdue`) side by side, with every state transition linked to Stellar Expert.

📖 Deep dive → [Trustless Work docs](https://docs.trustlesswork.com)

---

## 🌾 BudgetVault — deposit once, hire many, earn yield

The **fourth tier**, and the one enterprise/SMB buyers ask for by name.

**The problem:** buyers running 10–50 hires/month drop out when their wallet prompts a signature every time. Prepaid vault fixes that.

**The design:** a per-buyer Soroban contract mints on first deposit; every subsequent hire is *platform-relayed* under strict on-chain limits set by the buyer (allowlist + per-hire cap + total cap). The buyer never lets go of custody — the platform can only debit *within the buyer's pre-authorized envelope*.

**8 buyer control levers, on-chain:**

| Lever | Purpose |
|---|---|
| `total_cap` | Hard spending ceiling — vault refuses debits above cap |
| `per_hire_cap` | Per-task ceiling — bounds worst-case single-hire loss |
| `AllowlistMode::Slugs` | Whitelist specific agents (buyer curates a portfolio) |
| `AllowlistMode::Sellers` | Whitelist specific vendors (compliance-friendly for regulated industries) |
| `HireReceipt` event trail | On-chain audit ledger — every debit emits `seller · slug · amount · balance_after` |
| Deposit-once UX | 1 signature upfront, **0 signatures per hire** |
| Pause / close | Reversible pause; one-way close = auto-withdraw remaining balance |
| Multi-asset | USDC or MGUSD — pick based on downstream cash-out needs |

**And in v0.31 — yield on idle balance.** Any USDC / MGUSD sitting in a vault between hires earns **8% APY** for the first 30 days (boost) → **4% APY** thereafter, credited weekly as a treasury-signed SAC transfer directly into the vault contract address. Zero new signatures, zero Soroban contract change, byte-identical rollback via `FEATURE_M2_VAULT_YIELD=false`.

```
buyer deposits $200 USDC once ──▶ vault holds $200
                                      │
                                      │ hires $50 of agents this week
                                      │  (0 signatures, platform-relayed)
                                      ▼
                                 balance $150
                                      │
                                      │ weekly reward epoch
                                      │  ($150 × 8% × 7d/365 = +$0.23 MGUSD)
                                      ▼
                                 balance $150.23 — spendable on next hire
```

📖 [`docs/prd/PRD-N-vault-yield-rewards.md`](./docs/prd/PRD-N-vault-yield-rewards.md) · [`docs/runbooks/VAULT_YIELD_DEPLOY.md`](./docs/runbooks/VAULT_YIELD_DEPLOY.md)

---

## 🔐 ZK-private tier

Prove you paid — without revealing to whom.

- 🧬 **Circuit** — `prove_hire.circom` · Groth16 · BN254 · 1,034 R1CS constraints
- 🌀 **Hash** — Poseidon (ZK-friendly)
- 🎯 **Agent-bound** — proof for slug **A** can't replay on slug **B**
- ♻️ **Replay-proof** — `paid_calls.zk_commitment` UNIQUE index

```
Browser  →  snarkjs.groth16.fullProve (≈2 s)     →  x-zk-proof header
Server   →  verify + agent-bind + replay check   →  200 answer
Chain    →  usdc.transfer(buyer → platform)      →  seller invisible
```

Backed by **Nethermind's audited Stellar Privacy Pool** (5 external contracts) + our own Groth16 verifier binding. See addresses below.

📖 [`docs/runbooks/ZK_DEPLOY.md`](./docs/runbooks/ZK_DEPLOY.md)

---

## 📜 Deployed contracts — proof of work

All live on **Stellar testnet**. Every address is verifiable on [Stellar Expert](https://stellar.expert/explorer/testnet).

### 🦀 In-house Soroban contracts

| Contract | Purpose | Address |
|---|---|---|
| **agent-registry** | slug, price, seller, manifest hash | [`CCZHK4EI…4WBH`](https://stellar.expert/explorer/testnet/contract/CCZHK4EIJ35Z2EVYXHXOUQ2YAHAR7LQVRAQHJPAVTUTZOYXM4HDV4WBH) |
| **paywall-router** | Public-tier 95/5 split settlement (multi-asset) | [`CCGK4WJF…4QMV`](https://stellar.expert/explorer/testnet/contract/CCGK4WJFKFUDOXBDMSMMIBAVHZOZ6ME3UQY2WZ4IRN5BXCXJUB6C4QMV) |
| **paid-call-ledger** | Per-agent revenue + seller withdraw | [`CCLYNEHM…T2DF`](https://stellar.expert/explorer/testnet/contract/CCLYNEHM7GAZ7ZRD54MGTHU4OWNVJGZB7K7QPJPY4A3ZBOJFTKRXT2DF) |
| **budget-vault** *(v0.30)* | Deposit-once-hire-many buyer vault + v0.31 yield accrual | *deployed per-buyer at runtime — see `budget_vaults.contract_address`* |

### 🔐 Nethermind Privacy Pool (audited, external)

| Contract | Role | Address |
|---|---|---|
| **privacy-pool** | Poseidon Merkle-tree of shielded notes | [`CDRC5PLT…FC2Z`](https://stellar.expert/explorer/testnet/contract/CDRC5PLTTIIC7KJ4MFEE3NMLQ3YFWDX4GFPVT4ONMIDJC3KGRWLNFC2Z) |
| **privacy-pool-token** | USDC-wrapping vault | [`CDLZFC3S…CYSC`](https://stellar.expert/explorer/testnet/contract/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC) |
| **asp-membership** | Allow-list Association Set | [`CAN4INFN…ETAZ`](https://stellar.expert/explorer/testnet/contract/CAN4INFN4G3Z265I5DNUBLW3B2NJW2VBLKVWSVMX3MNJNDUEXI7QETAZ) |
| **asp-non-membership** | Proof-of-exclusion | [`CDXYPQEC…NDBW`](https://stellar.expert/explorer/testnet/contract/CDXYPQEC3VP5C5MYICD3J66TAVPVDVY5WCYB43APXOB2BCZPB6YDNDBW) |
| **groth16-verifier** | BN254 SNARK verifier | [`CBDFLMVY…XHK5`](https://stellar.expert/explorer/testnet/contract/CBDFLMVYC7YNMGVYNCSNNAOYBKUWFG4CFSOGY6JM6K77YIECZFWJXHK5) |

### 🛡️ Escrow rail — Trustless Work

| Item | Details |
|---|---|
| **API endpoint** | `https://dev.api.trustlesswork.com` (testnet) |
| **Escrow contracts** | Deployed per-hire by the buyer's wallet — each is a fresh Soroban contract. Full list in `hire_escrows.contract_address`. |
| **Health probe** | [`GET /v3/marketplace/escrow/health`](https://api.18-143-233-99.sslip.io/v3/marketplace/escrow/health) |

### 💵 Assets & platform

| Item | Address |
|---|---|
| **USDC SAC (Circle testnet)** | [`CBIELTK6…DAMA`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
| **USDC SAC (Circle mainnet)** | [`CCW67TSZ…MI75`](https://stellar.expert/explorer/public/contract/CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75) |
| **MGUSD SAC (M0 testnet · TMGUSD)** | [`CCWJCHDL…M7HM`](https://stellar.expert/explorer/testnet/contract/CCWJCHDLXEIMXODO5JFZLRUM7AMA7EI2NBRBL44ROCL6WH44W22NM7HM) |
| **MGUSD SAC (M0 mainnet)** | [`CDK2LDSY…WCJA`](https://stellar.expert/explorer/public/contract/CDK2LDSYUKPEFN3HNE7K7ETUT3VIOBHSOXAK5CTO4A4RKKZQUCAIWCJA) |
| **Platform Stellar account** | [`GAMURX…L5QZ`](https://stellar.expert/explorer/testnet/account/GAMURX2WC7IUYREU374TEPDLGV3YLK6HUVNTJBP5HYLTQHOCS4A4L5QZ) |
| **Live API** | [`https://api.18-143-233-99.sslip.io`](https://api.18-143-233-99.sslip.io/health) |

---

## 🏗️ Architecture at a glance

```
                 ┌─────────────────────────────────────────┐
                 │   Next.js 14 frontend (Stellar Wallets  │
                 │        Kit: Freighter · LOBSTR ·        │
                 │           Albedo · xBull · Rabet)       │
                 └───────────────────┬─────────────────────┘
                                     │  x-stellar-address · x-payment-mode
                                     ▼
                 ┌─────────────────────────────────────────┐
                 │      Express API (Node 20 · TypeScript) │
                 │  • stellarPaymentGate (4-tier selector) │
                 │  • budgetVault (deposit-once relayer)   │
                 │  • vaultRewards (weekly yield cron)     │
                 │  • escrowService (Trustless Work API)   │
                 │  • assetsRegistry (SEP-41 USDC + MGUSD) │
                 │  • anchorOnramp (SEP-24 MoneyGram)      │
                 │  • zk/verifier (Groth16 BN254)          │
                 └───────────────────┬─────────────────────┘
                                     │  Soroban RPC · SAC transfers
                                     ▼
                 ┌─────────────────────────────────────────┐
                 │            Stellar testnet              │
                 │  • 4 in-house Soroban contracts (Rust)  │
                 │  • 5 Nethermind Privacy Pool contracts  │
                 │  • per-hire Trustless Work escrow       │
                 │  • per-buyer BudgetVault (v0.30)        │
                 │  • Circle USDC + M0 MGUSD SACs          │
                 └─────────────────────────────────────────┘
```

---

## 🚀 Quick start

**Prereqs:** Node 20+ · Postgres (Supabase or local) · [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)

```bash
git clone https://github.com/phamdat721101/stellar-openx.git
cd stellar-openx && npm install

cp .env.example .env.local
# Fill: DATABASE_URL · STELLAR_PLATFORM_SECRET_KEY · OPENAI_API_KEY
#       TW_API_KEY   (Escrow tier — request at trustlesswork.com)

npm run db:migrate           # public + private + escrow + budget + yield schema
npm run soroban:deploy       # 4 in-house Soroban contracts
npm run seed:translator      # lighthouse agent (wallet-signed)
npm run dev                  # → http://localhost:3000
```

- 🛒 **Buyer** — home → match → connect wallet → pick tier → hire
- 🎨 **Seller** — `/studio` → mint agent → withdraw earnings
- 👤 **Both** — `/studio` = Purchases inbox · Escrow queue · Budgets · Earnings

**Regression gate:**

```bash
npm run smoke:all                    # cargo + marketplace + privacy-pool + ZK + escrow
RUN_MGUSD=1 RUN_YIELD=1 npm run smoke:all   # + MGUSD + BudgetVault + yield-rewards
```

---

## 📚 Deep dives

| To… | Read |
|---|---|
| 🧭 Onboard as an engineer | [`docs/PROJECT_CONTEXT.md`](./docs/PROJECT_CONTEXT.md) |
| 📐 Product decisions | [`docs/prd/PRD-S-stellar-native-mvp.md`](./docs/prd/PRD-S-stellar-native-mvp.md) |
| 🔐 Deploy ZK tier | [`docs/runbooks/ZK_DEPLOY.md`](./docs/runbooks/ZK_DEPLOY.md) |
| 💰 Deploy MGUSD + BudgetVault (v0.30) | [`docs/runbooks/MGUSD_BUDGET_DEPLOY.md`](./docs/runbooks/MGUSD_BUDGET_DEPLOY.md) |
| 🌾 Enable BudgetVault yield-rewards (v0.31) | [`docs/runbooks/VAULT_YIELD_DEPLOY.md`](./docs/runbooks/VAULT_YIELD_DEPLOY.md) · [PRD-N](./docs/prd/PRD-N-vault-yield-rewards.md) |
| 🛡️ Trustless Work integration | [Trustless Work docs](https://docs.trustlesswork.com) |
| 💵 MoneyGram Ramps SEP-24 | [MoneyGram Developer Portal](https://developer.moneygram.com/) |
| 🌐 Testnet snapshot | [`docs/runbooks/DEPLOY_LIVE.md`](./docs/runbooks/DEPLOY_LIVE.md) |
| 🏗️ Redeploy Soroban | [`docs/runbooks/STELLAR_DEPLOY.md`](./docs/runbooks/STELLAR_DEPLOY.md) |

---

## 🤝 Partners & standards

- **[Stellar Development Foundation](https://stellar.org)** — Soroban Rust smart contracts, SAC token standard, SEP-24 anchor spec, [agentic-payments docs](https://developers.stellar.org/docs/build/agentic-payments)
- **[Trustless Work](https://trustlesswork.com)** — Escrow-as-a-Service, non-custodial per-hire Soroban escrow contracts
- **[MoneyGram Digital Assets](https://developer.moneygram.com/)** — Fiat on/off-ramp at 500K retail locations across 200+ countries, MGUSD stablecoin issuance via M0
- **[Circle](https://www.circle.com/)** — USDC issuance on Stellar (testnet + mainnet SACs)
- **[Nethermind](https://github.com/NethermindEth/stellar-private-payments)** — Audited Stellar Privacy Pool (Poseidon Merkle tree + Groth16 verifier)
- **[M0 Foundation](https://m0.org)** — MGUSD stablecoin issuer

---

<div align="center">

MIT © [Pham Nim](https://github.com/phamdat721101)

*Per-task is the business model. Earnings are the artifact.*

</div>
