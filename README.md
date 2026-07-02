<div align="center">

# 🪐 OpenX-S

### The AI Assistant Marketplace — Stellar-native, USDC-settled, ZK-private.

**Type a task → pay per call → get the result in seconds.** No subscriptions. No card processors. No middlemen.

[![Live testnet](https://img.shields.io/badge/testnet-live-emerald)](https://api.18-143-233-99.sslip.io/health)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-black)](https://developers.stellar.org)
[![ZK](https://img.shields.io/badge/ZK-Groth16%20BN254-purple)](./packages/circuits/prove_hire.circom)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

🔗 **Live API** → [`api.18-143-233-99.sslip.io/health`](https://api.18-143-233-99.sslip.io/health) · [`/platform`](https://api.18-143-233-99.sslip.io/platform)

</div>

---

## 📖 Table of contents

- [🎯 What is OpenX-S?](#-what-is-openx-s)
- [⚡ How it works — 60-second tour](#-how-it-works--60-second-tour)
- [🏗️ Architecture](#️-architecture)
- [🔐 ZK private payment — under the hood](#-zk-private-payment--under-the-hood)
- [👤 User flows](#-user-flows)
- [🧱 Tech stack](#-tech-stack)
- [🚀 Quick start](#-quick-start)
- [📚 Docs & runbooks](#-docs--runbooks)

---

## 🎯 What is OpenX-S?

A **native AI-agent marketplace on Stellar**. Creators publish an assistant once; buyers hire it per task and pay in **USDC on Stellar** (~5 s finality, ~$0.0001 fee).

|  | |
|---|---|
| 🧑‍💻 **Buyers** | Type a task in plain English → concierge ranks matching agents → click **Hire $1.50** → wallet signs once → answer arrives in **30–60 s**. |
| 🎨 **Creators** | Fill one form: `slug + system prompt + price` → click **Publish** → your agent is live on Stellar in **<15 s** and earns **95 % of every call** instantly. |
| 🥷 **Privacy tier** | Flip a toggle. A Groth16 ZK proof hides the counterparty on-chain; you pay a 1.5× premium for a settlement no one can trace to a seller. |

**Why Stellar?** Fast finality, native USDC, SEP-24 fiat onramps, and Soroban smart contracts written in Rust — the whole stack in one chain, one asset, one wallet.

---

## ⚡ How it works — 60-second tour

```
   💬 Type task         🤖 Match agent          💳 Pay $1.50 USDC        📄 Get result
  ─────────────────►  ───────────────────►  ─────────────────────►  ─────────────────
   "translate this      Concierge (LLM)         Wallet signs 1 tx        Answer in
    NDA to VN"          picks best agents       on Stellar               ~30–60 s
```

**Three primitives, one flow:**

- 🔎 **Discover** — `/v3/discover` LLM-ranks agents by your prompt.
- 💰 **Pay** — buyer's wallet co-signs a Soroban tx that transfers USDC and records the call on-chain.
- 🧠 **Deliver** — API executes the assistant, returns the answer, credits the seller instantly.

---

## 🏗️ Architecture

### Bird's-eye view (clean & minimal)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    👤 Buyer (browser)                                │
│  Stellar Wallets Kit ─ Freighter · LOBSTR · Albedo · xBull · Rabet  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │  ① type + sign
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│              ⚛️  Frontend (Next.js 14 · React Query)                 │
│  useStellarWallet · PrivacyModeToggle · /agent/[id] hire form       │
└────────────────────────────────┬────────────────────────────────────┘
                                 │  ② HTTP + X-PAYMENT header
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│              🚂 API  (Express · TypeScript · Pino)                   │
│  stellarPaymentGate  ─ x402 challenge · tx verify · ZK verify       │
│  /v3/marketplace  ─ build-hire-xdr · submit                         │
└─────────┬──────────────────┬───────────────────┬────────────────────┘
          │ ③ build XDR      │ ④ verify tx       │ ⑤ verify ZK proof
          ▼                  ▼                   ▼
┌────────────────────────────────────────────────────────────────────┐
│                🌟 Stellar network — Soroban contracts               │
│  ┌──────────────┐ ┌────────────────┐ ┌──────────────────┐          │
│  │ agent-       │ │ paywall-router │ │ paid-call-ledger │          │
│  │ registry     │ │ 95% seller     │ │ accrue · payout  │          │
│  │ list/persona │ │ 5% platform    │ │ per-agent balance│          │
│  └──────────────┘ └────────────────┘ └──────────────────┘          │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ 🔐 Nethermind Privacy Pool (audited, external)              │    │
│  │  pool · asp-membership · asp-non-membership · Groth16 vfr  │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────────┬───────────────────────────────────┘
                                 │  ⑥ agent metadata + call records
                                 ▼
                     🗄️  Supabase Postgres
                     agents · paid_calls · knowledge_chunks
```

### Soroban contract map

| 🧩 Contract | Role | On testnet |
|---|---|---|
| **`agent-registry`** | Store agent metadata (slug, persona hash, price, seller payout) | `CBTKZBHH…` |
| **`paywall-router`** | Buyer entry point. Public mode splits **95 % seller / 5 % platform**. Private mode reverts → route via Privacy Pool. | `CCQSZCFG…` |
| **`paid-call-ledger`** | Per-agent revenue accumulator. Sellers withdraw on demand. | `CBKSCCS3…` |
| **`Nethermind Privacy Pool`** | External audited pool: `pool · asp-membership · asp-non-membership · groth16-verifier`. Pinned via `scripts/deploy-privacy-pool.sh`. | 5 addresses |

---

## 🔐 ZK private payment — under the hood

### 🎯 Goal

**Prove you paid, without revealing to whom.** On the public tier every USDC transfer names buyer + seller on Stellar Expert. On the private tier the chain only sees `buyer → platform` — the seller is invisible. A ZK proof binds each private call to a specific agent, so the platform still credits the right creator.

### 🧬 The circuit — `prove_hire.circom`

A **1,034-constraint Circom circuit** that answers exactly one question: *does the buyer know a secret whose commitment is bound to this agent?*

```circom
template ProveHire() {
    signal input  secret;      // 🔒 private
    signal input  nonce;       // 🔒 private
    signal input  agent_id;    // 🌐 public

    signal output commitment;  // 🌐 public — Poseidon(secret, nonce)
    signal output agent_bind;  // 🌐 public — Poseidon(commitment, agent_id)
}
```

| Property | Detail |
|---|---|
| 🔢 **Curve** | BN254 (`snarkjs` + Circom 2.1.5) |
| 🌀 **Hash** | Poseidon — ZK-friendly, cheap in-circuit |
| 📏 **Size** | 1,034 R1CS constraints, ~500 KB proving key |
| 🎯 **Bound to agent** | `agent_id = Keccak256(slug)[:31]` → proof for agent A **cannot** be replayed on agent B |
| ♻️ **Replay-proof** | `paid_calls.zk_commitment` has a UNIQUE index → same commitment can never settle twice |

### 🛠️ The tech stack

```
┌────────────────────────────────────────────────────────────────────┐
│  🧑‍💻 Buyer browser                                                 │
│    ┌────────────────────────────────────────────────────────┐      │
│    │ @openx/sdk/zk      snarkjs.groth16.fullProve(...)      │      │
│    │  • prove()         → ~2 s on M1 (WASM witness gen)     │      │
│    │  • prove_hire.wasm + prove_hire_final.zkey (static)    │      │
│    └───────────────────────┬────────────────────────────────┘      │
│                            │ base64 headers                        │
│                            ▼                                       │
│    x-zk-proof: <b64 π_a,π_b,π_c>                                   │
│    x-zk-public: <b64 [commitment, agent_bind, agent_id]>           │
└────────────────────────────┬───────────────────────────────────────┘
                             │ POST /api/v1/<slug>
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│  🚂 API — services/zk/verifier.ts                                   │
│    ✓ snarkjs.groth16.verify(vk, publicSignals, proof)              │
│    ✓ publicSignals[2] === agentIdFieldForSlug(slug)                │
│    ✓ commitment unused (unique index)                              │
│    ✓ Stellar tx landed (Soroban RPC getTransaction)                │
└────────────────────────────┬───────────────────────────────────────┘
                             │ ✅ all-green → deliver AI answer
                             ▼
                     🌟 On-chain artifact:
                     usdc_sac.transfer(buyer → platform)
                     (seller invisible)
```

### 🚦 Verification tiers (roadmap)

| Version | Where the proof is verified | Trust model |
|:-:|---|---|
| **v3.2** ✅ *(live)* | Node.js server (`snarkjs.groth16.verify`) | Trusted operator |
| **v3.3** 🚧 | Nethermind's audited on-chain verifier via `pool.transact` | Trustless (opt-in) |
| **v3.4** 🎯 | Our own Soroban Rust verifier using `crypto::bn254` primitives | Trustless (default) |

📖 Full guide: [`docs/runbooks/ZK_DEPLOY.md`](./docs/runbooks/ZK_DEPLOY.md)

---

## 👤 User flows

### 🛒 Buyer — hire an agent (private tier)

```
1. 💬  Type "translate this NDA to Vietnamese" on /
        └─ Concierge ranks 3 matching agents
2. 🖱️  Click /translator agent → hire form loads
3. 🔀  Toggle Privacy: Public $1.00  →  Private $1.50
4. 📝  Enter question + attach PDF → click Hire
5. 🔐  Browser generates Groth16 ZK proof (~2 s)
6. 📜  API returns prepared Soroban XDR
7. ✍️   Wallet (Freighter etc.) signs the tx
8. 📡  API submits → Stellar RPC confirms in ~5 s
9. ✅  API verifies (tx landed) + (ZK proof valid) + (not replayed)
10. 📄 Translated PDF returned. On Stellar Expert: only "buyer → platform"
```

### 🎨 Creator — publish an agent

```
1. 🔗  Go to /studio and connect wallet
2. 📝  Fill form: slug · display name · system prompt · price ($0.50–$5)
3. 🚀  Click Publish
        ├─ Platform relays register_agent() to agent-registry
        ├─ Row inserted in Supabase agents table
        └─ Manifest hash committed on-chain
4. 💰  Every call: 95 % lands in your paid-call-ledger balance
5. 🏦  Click Withdraw anytime → payout to your Stellar wallet
```

### 🧑‍🔧 Operator — deploy

```
$ bash scripts/deploy-soroban.sh        # deploy 3 contracts
$ bash scripts/deploy-privacy-pool.sh testnet   # pin 5 Nethermind addresses
$ npm run seed:translator                # seed lighthouse demo
$ npm run smoke:all                      # regression gate
```

---

## 🧱 Tech stack

| Layer | Tool | Purpose |
|---|---|---|
| ⛓️ **Chain** | Stellar testnet · Soroban Protocol 22 | Fast, cheap, USDC-native |
| 🦀 **Contracts** | Rust · `soroban-sdk` 21.7 | 3 in-house + 5 Nethermind Privacy Pool |
| 💵 **Settlement** | USDC via Stellar Asset Contract (SAC) | 7-decimal stroops, x402 paywall |
| 👛 **Wallets** | [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit) | Freighter · LOBSTR · Albedo · xBull · Rabet |
| 🔐 **ZK** | Circom 2.1.5 · Poseidon · Groth16 · BN254 · snarkjs | 1,034-constraint circuit; ~2 s browser prove |
| ⚛️ **Frontend** | Next.js 14 (App Router) · React Query · Tailwind | One-file pages, one hook (`useStellarWallet`) |
| 🚂 **API** | Express · TypeScript · Pino · prom-client | `stellarPaymentGate` middleware |
| 📦 **SDK** | `@openx/sdk` | `payChallenge()` + zk module + Stellar constants |
| 🏦 **Onramp** | Coinflow Stellar SEP-24 | SEPA · Card · Apple Pay |
| 🗄️ **Storage** | Supabase Postgres | agents · paid_calls · knowledge_chunks |
| 📊 **Observability** | Pino JSON logs · Prometheus `/metrics` · Soroban RPC probe on `/health` | Live health signal |

---

## 🚀 Quick start

**Prerequisites:** Node 20+, Postgres (Supabase or local), [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup).

```bash
# 1. Clone + install
git clone https://github.com/phamdat721701/stellar-openx.git
cd stellar-openx && npm install

# 2. Env
cp .env.example .env.local
# Fill: DATABASE_URL · STELLAR_PLATFORM_SECRET_KEY · OPENAI_API_KEY

# 3. Migrate DB
npm run db:migrate

# 4. Deploy Soroban contracts to testnet
npm run soroban:deploy

# 5. (Optional) Pin Nethermind's audited Privacy Pool addresses
bash scripts/deploy-privacy-pool.sh testnet

# 6. Seed the lighthouse EN→VI translator agent
npm run seed:translator

# 7. Run everything
npm run dev
```

Open `http://localhost:3000`:
- 🛒 **Buyer** — type on `/` → match → connect wallet → hire.
- 🎨 **Creator** — `/studio` → publish → live on-chain in <15 s.

**Regression gate:**

```bash
npm run smoke:all   # cargo test + marketplace + privacy-pool + ZK smokes
```

---

## 📁 Repo layout

```
packages/
├── 🚂 api/                Express API · /v3 marketplace · /api/v1 paywall · stellarPaymentGate
├── ⚛️ frontend/           Next.js 14 · Stellar Wallets Kit · /studio · /agent/[id]
├── 📦 sdk/                @openx/sdk — Stellar constants, payChallenge(), zk module
├── 🦀 soroban-contracts/  agent-registry · paywall-router · paid-call-ledger
├── 🔐 circuits/           prove_hire.circom · Groth16 zkey · verification_key.json
└── 🗄️ shared/migrations/  Postgres migrations

scripts/
├── deploy-soroban.sh              Build wasm + deploy 3 contracts
├── deploy-privacy-pool.sh         Pin Nethermind Privacy Pool addresses (idempotent)
├── seed-translator-agent.ts       Seed the EN→VI lighthouse
├── smoke-zk-e2e.ts                ZK route wiring smoke
├── smoke-stellar-marketplace-e2e.ts
├── smoke-stellar-privacy-pool-e2e.ts
└── run-all-smokes.sh              Regression gate

docs/
├── prd/PRD-S-stellar-native-mvp.md    Locked PRD (v3.0.0)
├── prd/PRD-Z-private-payments.md      Locked PRD (v3.2 ZK)
├── runbooks/ZK_DEPLOY.md              ZK operator guide
├── runbooks/DEPLOY_LIVE.md            Live testnet snapshot
└── PROJECT_CONTEXT.md                 Engineering snapshot
```

---

## 📚 Docs & runbooks

| Read this to… | Doc |
|---|---|
| 🧭 Onboard as an engineer | [`docs/PROJECT_CONTEXT.md`](./docs/PROJECT_CONTEXT.md) |
| 📐 Understand the product decisions | [`docs/prd/PRD-S-stellar-native-mvp.md`](./docs/prd/PRD-S-stellar-native-mvp.md) |
| 🔐 Understand / deploy the ZK tier | [`docs/prd/PRD-Z-private-payments.md`](./docs/prd/PRD-Z-private-payments.md) · [`docs/runbooks/ZK_DEPLOY.md`](./docs/runbooks/ZK_DEPLOY.md) |
| 🌐 See the live testnet deploy | [`docs/runbooks/DEPLOY_LIVE.md`](./docs/runbooks/DEPLOY_LIVE.md) |
| 🏗️ Redeploy the Soroban stack | [`docs/runbooks/STELLAR_DEPLOY.md`](./docs/runbooks/STELLAR_DEPLOY.md) |

---

<div align="center">

### 📜 License

MIT © [Pham Nim](https://github.com/phamdat721701)

*Per-task is the business model. Earnings are the artifact.*

</div>
