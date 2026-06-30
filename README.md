# OpenX-S — the AI Assistant Marketplace (Stellar-native + ZK)

> 🟢 **Live on Stellar testnet** — API at [`https://api.18-143-233-99.sslip.io/health`](https://api.18-143-233-99.sslip.io/health) · live config in [`docs/runbooks/DEPLOY_LIVE.md`](docs/runbooks/DEPLOY_LIVE.md)

> **Hire AI assistants. Pay per task. Get the result in seconds.**
>
> Creators publish AI assistants once and earn instantly when anyone uses them. Buyers describe what they need, pay $0.50–$5 per task in USDC on Stellar, and get the result in 30–60 seconds. Optional Privacy Pool premium tier hides amount + counterparty.

| | |
|---|---|
| **Chain** | Stellar (testnet for v3.0.0; mainnet gated on audit) |
| **Settlement** | USDC on Stellar (Stellar Asset Contract) |
| **Wallet** | [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit) — Freighter / LOBSTR / Albedo / xBull / Rabet |
| **Onramp** | Coinflow Stellar SEP-24 (SEPA · Card · Apple Pay) |
| **Privacy tier** | Privacy Pool (Nethermind fork) with Groth16 proof verification |
| **License** | MIT |

---

## What it does

A user types `translate this NDA to Vietnamese` into the chat box. They drop the PDF, click **Pay $1.50**, sign once with their Stellar wallet (Freighter / LOBSTR / Albedo / xBull / Rabet), and get the translated PDF back ~30–60 seconds later. On-chain, USDC moves twice in a single Soroban transaction — 95 % to the creator, 5 % to the platform.

That's the **lighthouse demo**: the EN→VI Legal Document Translator. The same primitive runs every other assistant in the marketplace. Same flow: type → pay → result.

Hit the **Private** toggle and the same transaction routes through the Privacy Pool — amount and counterparty are opaque on Stellar Expert, payable at a 1.5× premium.

---

## Architecture

```
Buyer (Stellar Wallets Kit — Freighter / LOBSTR / Albedo / xBull / Rabet)
       │
       ▼
Next.js 14 frontend ── useStellarWallet (single hook)
       │
       ▼
Express API ── /v3 marketplace + concierge (chain-agnostic logic preserved)
       │
       ├── stellarPaymentGate middleware (x402-on-Stellar; public | private)
       ├── stellar/marketplace.ts ──► agent-registry · paywall-router · paid-call-ledger
       ├── stellar/anchorOnramp.ts ──► Coinflow Stellar SEP-24
       └── stellar/privacyPool.ts ──► privacy-pool (Nethermind fork)
       │
       ▼
Supabase Postgres (agents · paid_calls · knowledge_chunks · buyer_credits)
```

### Soroban contracts

| Contract | Purpose |
|---|---|
| `agent-registry` | Agent listings + metadata (slug, persona hash, price, seller payout) |
| `paywall-router` | Buyer-side x402 entry. 95 % seller / 5 % platform USDC split |
| `paid-call-ledger` | Per-agent revenue accumulator. Sellers withdraw on demand |
| `privacy-pool` | Optional Privacy Pool premium tier (Nethermind fork) |

Build: `npm run soroban:build` · Test: `npm run soroban:test` · Deploy: `npm run soroban:deploy`.

---

## Try it locally

Requires Node 20+, Postgres (Supabase or local), and the `stellar` CLI ([install](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)).

```bash
git clone https://github.com/phamdat721701/stellar-openx.git
cd stellar-openx
npm install

# 1. Configure env
cp .env.example .env.local
# Fill DATABASE_URL, STELLAR_PLATFORM_SECRET_KEY, and OPENAI_API_KEY

# 2. Apply migrations
npm run db:migrate

# 3. Deploy Soroban contracts to testnet
npm run soroban:deploy

# 4. Seed the lighthouse translator
npm run seed:translator

# 5. Run the full stack
npm run dev
```

Then on http://localhost:3000:

- **Buyer** — type a task on `/`. Concierge ranks agents → connect Freighter → click **Hire $1.50** → translated PDF returns.
- **Creator** — `/seller` is a one-page form. Slug + persona + price → click **Publish** → on-chain in <15 s.

Run the regression suite:

```bash
npm run smoke:all
```

---

## Repo layout

```
packages/
├── api/                Express API · /v3 marketplace · /api/v1 paywall · stellarPaymentGate
├── frontend/           Next.js 14 · Stellar Wallets Kit · home + marketplace + seller
├── sdk/                @openx/sdk — Stellar constants, payment types, payChallenge()
├── soroban-contracts/  Rust Soroban — agent-registry · paywall-router · paid-call-ledger · privacy-pool
└── shared/migrations/  Postgres migrations (applied in lexical order)

scripts/
├── deploy-soroban.sh             Build wasm + deploy all four contracts
├── start-dev.sh                  One-command dev runner
├── seed-translator-agent.ts      Seed the EN→VI lighthouse
├── smoke-stellar-marketplace-e2e.ts
├── smoke-stellar-privacy-pool-e2e.ts
├── smoke-coinflow-stellar-e2e.ts
└── run-all-smokes.sh             Regression gate

docs/
├── prd/PRD-S-stellar-native-mvp.md  Locked PRD
├── runbooks/STELLAR_DEPLOY.md       Deploy + ops guide
└── PROJECT_CONTEXT.md               Engineering snapshot
```

---

## Tech stack

| Layer | Tool |
|---|---|
| Smart contracts | Soroban (Rust) — `agent-registry` · `paywall-router` · `paid-call-ledger` · `privacy-pool` (Nethermind fork) |
| Frontend | Next.js 14 · Stellar Wallets Kit · React Query |
| API | Express · TypeScript · Pino · prom-client |
| Wallet | Freighter / LOBSTR / Albedo / xBull / Rabet (Stellar Wallets Kit) |
| Settlement | USDC on Stellar (SAC); x402-on-Stellar paywall |
| Onramp | Coinflow Stellar SEP-24 (mock-friendly in dev) |
| Privacy | Privacy Pool (Nethermind fork) + audited Groth16 verifier deployed separately |
| Storage | Postgres (Supabase or local) |
| Observability | Pino + Prometheus `/metrics` · live Stellar RPC probe on `/health` |

---

## License

MIT. © Pham Nim ([@phamdat721701](https://github.com/phamdat721701)).

*Per-task is the business model. Earnings are the artifact.*
