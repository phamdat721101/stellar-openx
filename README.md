<div align="center">

# 🪐 OpenX-S

### The AI-Agent Marketplace — Stellar-native · USDC-settled · ZK-private · Escrow-protected

**Type a task → pay per call → get the answer in seconds.**
No subscriptions. No card processors. No middlemen.

[![Live API](https://img.shields.io/badge/testnet-live-emerald)](https://api.18-143-233-99.sslip.io/health)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-black)](https://developers.stellar.org)
[![ZK](https://img.shields.io/badge/ZK-Groth16-purple)](./packages/circuits/prove_hire.circom)
[![Escrow](https://img.shields.io/badge/Escrow-Trustless%20Work-amber)](https://trustlesswork.com)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## 🎯 What is OpenX-S?

A native marketplace where **sellers publish an AI assistant once** and **buyers hire it per task**, settling in **USDC on Stellar** (~5 s finality, ~$0.0001 fee).

| Actor | Flow |
|---|---|
| 🧑‍💻 **Buyer** | type task → concierge ranks agents → pick a tier → sign → answer in 30–60 s |
| 🎨 **Seller** | one form → wallet signs mint → agent live in <15 s → keeps **95 %** of every call |

**Why Stellar?** Fast finality · native USDC · Soroban Rust contracts · SEP-24 fiat rails.

---

## 💳 Three payment tiers, one wallet

| | 🌐 **Public** | 🕶️ **Private** | 🛡️ **Escrow** | 💰 **Budget** |
|---|:---:|:---:|:---:|:---:|
| **Rate** | 1.0× base | 1.5× base | 2.0× base | 1.0× base **+ 4-8% APY yield** |
| **Settles via** | `paywall-router` (multi-asset) | Privacy Pool + ZK proof | Trustless Work escrow | `budget-vault` (deposit-once) · idle balance earns weekly rewards |
| **Counterparty on-chain?** | ✅ visible | ❌ hidden | ✅ visible | ✅ visible |
| **Buyer-approval gate?** | ❌ instant | ❌ instant | ✅ buyer signs release | ❌ instant |
| **Wallet signatures** | 1 | 1 + 1 ZK proof | 4 (deploy, fund, approve, release) | **0 per hire** (1 upfront deposit) |
| **Assets** | USDC · MGUSD | USDC | USDC | USDC · MGUSD |
| **Best for** | microtasks $0.05–$1 | privacy-sensitive | high-value $5+ | 10–50 hires/month workflows |

---

## 🔐 ZK-private tier

Prove you paid — without revealing to whom.

- 🧬 **Circuit** — `prove_hire.circom` · Groth16 · BN254 · 1,034 R1CS constraints
- 🌀 **Hash** — Poseidon (ZK-friendly)
- 🎯 **Agent-bound** — proof for slug **A** can't replay on slug **B**
- ♻️ **Replay-proof** — `paid_calls.zk_commitment UNIQUE` index

```
Browser  →  snarkjs.groth16.fullProve (≈2 s)     →  x-zk-proof header
Server   →  verify + agent-bind + replay check   →  200 answer
Chain    →  usdc.transfer(buyer → platform)      →  seller invisible
```

📖 [`docs/runbooks/ZK_DEPLOY.md`](./docs/runbooks/ZK_DEPLOY.md)

---

## 🛡️ Escrow-protected tier

Funds locked in a **non-custodial Soroban contract** until the buyer approves the delivered answer. Powered by **[Trustless Work](https://trustlesswork.com)** (Escrow-as-a-Service).

**Roles — fully trustless, platform only arbitrates disputes:**

| Role | Who |
|---|---|
| 👤 Payer + Approver + Release signer | **Buyer** |
| 🎨 Receiver + Service provider | **Seller** |
| 🏛️ Dispute resolver (arbitrator only) | **OpenX platform** |

**Lifecycle:**

```
① buyer signs DEPLOY   →  TW mints a fresh escrow contract
② buyer signs FUND     →  USDC locked in escrow
③ agent DELIVERS       →  gate verifies funded state, marks answered
④ buyer signs APPROVE + RELEASE  →  USDC → seller
                        OR
   buyer signs DISPUTE →  frozen, platform reviews
                        OR
   24 h idle           →  seller claims via dispute-then-auto-resolve
```

**Self-healing:** `GET /v3/marketplace/escrow/me` reads the escrow's USDC balance via Soroban SAC on every call. If 0 → funds moved out → DB auto-transitions the row to `released` / `resolved`. No stuck escrows.

**UX surface — one page (`/studio`), both sides:**

- 👤 **Buyer inbox** — every purchase with `[Approve & release]` / `[Dispute]` buttons + explorer chips
- 🎨 **Seller queue** — pending sales with countdown + `[Sync]` + `[Claim overdue]`
- 🔗 Every row exposes `deploy / fund / approve / release / dispute / resolve` tx links to Stellar Expert

---

## 📜 Deployed contracts — proof of work

All live on **Stellar testnet**. Copy any address → verify tx history on [Stellar Expert](https://stellar.expert/explorer/testnet).

### 🦀 In-house Soroban contracts

| Contract | Purpose | Address |
|---|---|---|
| **agent-registry** | slug, price, seller, manifest hash | [`CCZHK4EI…4WBH`](https://stellar.expert/explorer/testnet/contract/CCZHK4EIJ35Z2EVYXHXOUQ2YAHAR7LQVRAQHJPAVTUTZOYXM4HDV4WBH) |
| **paywall-router** | Public-tier 95/5 split settlement (multi-asset) | [`CCGK4WJF…4QMV`](https://stellar.expert/explorer/testnet/contract/CCGK4WJFKFUDOXBDMSMMIBAVHZOZ6ME3UQY2WZ4IRN5BXCXJUB6C4QMV) |
| **paid-call-ledger** | Per-agent revenue + seller withdraw | [`CCLYNEHM…T2DF`](https://stellar.expert/explorer/testnet/contract/CCLYNEHM7GAZ7ZRD54MGTHU4OWNVJGZB7K7QPJPY4A3ZBOJFTKRXT2DF) |
| **budget-vault** *(v0.30)* | Deposit-once-hire-many buyer vault (allowlist + caps) | *deployed per-buyer at runtime — see `budget_vaults.contract_address`* |

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

### 💵 Asset & platform

| Item | Address |
|---|---|
| **USDC SAC (Circle testnet)** | [`CBIELTK6…DAMA`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
| **USDC SAC (Circle mainnet)** | [`CCW67TSZ…MI75`](https://stellar.expert/explorer/public/contract/CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75) |
| **MGUSD SAC (M0 testnet · TMGUSD)** *(v0.30)* | [`CCWJCHDL…M7HM`](https://stellar.expert/explorer/testnet/contract/CCWJCHDLXEIMXODO5JFZLRUM7AMA7EI2NBRBL44ROCL6WH44W22NM7HM) |
| **MGUSD SAC (M0 mainnet)** *(v0.30)* | [`CDK2LDSY…WCJA`](https://stellar.expert/explorer/public/contract/CDK2LDSYUKPEFN3HNE7K7ETUT3VIOBHSOXAK5CTO4A4RKKZQUCAIWCJA) |
| **Platform Stellar account** | [`GAMURX…L5QZ`](https://stellar.expert/explorer/testnet/account/GAMURX2WC7IUYREU374TEPDLGV3YLK6HUVNTJBP5HYLTQHOCS4A4L5QZ) |
| **Live API** | [https://api.18-143-233-99.sslip.io](https://api.18-143-233-99.sslip.io/health) |

---

## 🚀 Quick start

**Prereqs:** Node 20+ · Postgres (Supabase or local) · [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)

```bash
git clone https://github.com/phamdat721721/stellar-openx.git
cd stellar-openx && npm install

cp .env.example .env.local
# Fill: DATABASE_URL · STELLAR_PLATFORM_SECRET_KEY · OPENAI_API_KEY
#       TW_API_KEY   (Escrow tier — request at trustlesswork.com)

npm run db:migrate           # public + private + escrow schema
npm run soroban:deploy       # 3 in-house Soroban contracts
npm run seed:translator      # lighthouse agent (wallet-signed)
npm run dev                  # → http://localhost:3000
```

- 🛒 **Buyer** — home → match → connect wallet → pick tier → hire
- 🎨 **Seller** — `/studio` → mint agent → withdraw earnings
- 👤 **Both** — `/studio` = Purchases inbox + Escrow queue + published agents

**Regression gate:**

```bash
npm run smoke:all   # cargo + marketplace + privacy-pool + ZK + escrow
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
| 🌐 Testnet snapshot | [`docs/runbooks/DEPLOY_LIVE.md`](./docs/runbooks/DEPLOY_LIVE.md) |
| 🏗️ Redeploy Soroban | [`docs/runbooks/STELLAR_DEPLOY.md`](./docs/runbooks/STELLAR_DEPLOY.md) |

---

<div align="center">

MIT © [Pham Nim](https://github.com/phamdat721721) — *Per-task is the business model. Earnings are the artifact.*

</div>
