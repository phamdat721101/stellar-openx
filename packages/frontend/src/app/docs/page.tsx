'use client';

/**
 * /docs — quick-start + interactive mint.
 *
 * Two things in one page:
 *   • #mint — interactive concierge form (POST /v3/concierge/onboard). This
 *     is the ONLY entry point for minting an agent on Stellar OpenX-S.
 *   • Reference — curl snippets for hire / publish-by-cURL / private tier /
 *     fiat top-up.
 *
 * SOLID:
 *   • SRP — page composes <MintForm /> + a list of static SECTIONS. Each
 *     concern stays small and local.
 *   • OCP — to add a doc topic, append to SECTIONS; the rendering loop is
 *     untouched.
 */

import { useState } from 'react';
import Link from 'next/link';
import { API_URL } from '@/lib/stellar';

// ─── #mint — interactive concierge ────────────────────────────────────────

type LiveResult = {
  status: 'live';
  agent_id: string;
  slug: string;
  agent_url: string;
  paywall_url: string;
  curl_example: string;
  message: string;
  verification_status: 'verified' | 'unverified';
  extraction_confidence: number;
  next_steps: string[];
};
type ClarifyResult = { status: 'needs_clarification'; message: string; missing_fields: string[] };
type DuplicateResult = { status: 'duplicate'; slug: string; agent_url: string };
type ErrorResult = { error: string; message?: string };
type MintResult = LiveResult | ClarifyResult | DuplicateResult | ErrorResult;

const EXAMPLE_PROMPT =
  'My agent translates English legal documents into Vietnamese. ' +
  '$0.05 per query in USDC on Stellar. ' +
  'Hosted at https://my-translator.example.com/api.';

function MintForm() {
  const [prompt, setPrompt] = useState('');
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<MintResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setLoading(true);
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch(`${API_URL}/v3/concierge/onboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, operator_email: email || undefined }),
      });
      setResult((await res.json()) as MintResult);
    } catch (err) {
      setResult({ error: 'network_error', message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  function copyCurl(text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }

  const live = result && 'status' in result && result.status === 'live' ? result : null;
  const clarify =
    result && 'status' in result && result.status === 'needs_clarification' ? result : null;
  const dup = result && 'status' in result && result.status === 'duplicate' ? result : null;
  const errResult = result && 'error' in result ? result : null;

  return (
    <section
      id="mint"
      className="scroll-mt-24 space-y-4 rounded-xl border border-primary-container/40 bg-surface-container-low p-6"
    >
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-wider text-primary-container">
          ⭐ Mint by prompt
        </p>
        <h2 className="text-2xl font-bold">Publish an AI agent in one sentence.</h2>
        <p className="text-sm text-on-surface-variant">
          Describe your agent. The concierge LLM extracts a manifest, probes <code className="font-mono text-on-surface-variant">/openx/health</code>, and puts it live on Stellar in about 10s. No wallet needed to mint — bind a Stellar payout address later.
        </p>
      </header>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-on-surface-variant">Describe your agent</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={EXAMPLE_PROMPT}
          maxLength={2000}
          className="block h-32 w-full resize-none rounded-lg border border-outline-variant/40 bg-background p-3 text-sm focus:border-primary-container focus:outline-none"
        />
        <span className="text-xs text-on-surface-variant/70">{prompt.length} / 2000 (min 30)</span>
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-on-surface-variant">Operator email (optional)</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="block w-full rounded-lg border border-outline-variant/40 bg-background p-2 text-sm focus:border-primary-container focus:outline-none"
        />
      </label>

      <button
        onClick={submit}
        disabled={loading || prompt.trim().length < 30}
        className="rounded-lg bg-primary-container text-on-primary px-5 py-2 text-sm font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'Publishing… (~10s)' : 'Mint agent on Stellar'}
      </button>

      {live && (
        <div className="space-y-3 rounded-lg border-l-4 border-primary-container bg-primary-container/10 p-5 text-sm">
          <h3 className="text-base font-bold text-primary-container">✓ Live on Stellar</h3>
          <p className="text-on-surface">{live.message}</p>
          <dl className="grid gap-1.5 text-xs">
            <Kv k="Marketplace">
              <Link href={`/agent/${live.agent_id}`} className="text-primary-container underline">
                /agent/{live.agent_id}
              </Link>
            </Kv>
            <Kv k="Paywall">
              <span className="font-mono">{live.paywall_url}</span>
            </Kv>
            <Kv k="Verification">
              {live.verification_status === 'verified' ? (
                <span className="rounded bg-primary-container/20 px-1.5 py-0.5 font-mono text-primary-container">
                  ✓ reachable
                </span>
              ) : (
                <span className="rounded bg-yellow-900/40 px-1.5 py-0.5 font-mono text-yellow-300">
                  ⚠ implement POST /openx/health to verify
                </span>
              )}
            </Kv>
            <Kv k="Confidence">{(live.extraction_confidence * 100).toFixed(0)}%</Kv>
          </dl>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium">Try it from a terminal</span>
              <button
                onClick={() => copyCurl(live.curl_example)}
                className="text-xs text-primary-container hover:underline"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="overflow-x-auto rounded bg-black/40 p-3 font-mono text-[11px] text-primary-container">
              {live.curl_example}
            </pre>
          </div>
          <ul className="space-y-1 text-on-surface-variant">
            {live.next_steps.map((s, i) => (
              <li key={i}>→ {s}</li>
            ))}
          </ul>
        </div>
      )}

      {clarify && (
        <div className="rounded-lg border-l-4 border-yellow-500 bg-yellow-950/30 p-4 text-sm">
          <h3 className="font-bold text-yellow-300">Need a bit more info</h3>
          <p className="mt-1 text-on-surface">{clarify.message}</p>
          {clarify.missing_fields?.length > 0 && (
            <p className="mt-1 text-xs text-yellow-200">Missing: {clarify.missing_fields.join(', ')}</p>
          )}
        </div>
      )}

      {dup && (
        <div className="rounded-lg border-l-4 border-tertiary-container bg-tertiary-container/10 p-4 text-sm">
          <h3 className="font-bold text-tertiary-container">Slug already in use</h3>
          <p className="mt-1 text-on-surface">
            <code className="font-mono">/{dup.slug}</code> exists.{' '}
            <Link href={`/agent/${dup.slug}`} className="text-tertiary-container underline">
              View →
            </Link>
          </p>
        </div>
      )}

      {errResult && (
        <div className="rounded-lg border-l-4 border-error bg-error/10 p-4 text-sm">
          <h3 className="font-bold text-error">Something went wrong</h3>
          <p className="mt-1 text-on-surface">{errResult.message ?? errResult.error}</p>
        </div>
      )}
    </section>
  );
}

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-28 shrink-0 text-on-surface-variant/70">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

// ─── Reference sections (static cURL snippets) ────────────────────────────

const API = API_URL || 'https://api.18-143-233-99.sslip.io';

const SECTIONS = [
  {
    id: 'hire',
    title: 'Hire an agent (HTTP)',
    body: `Every published agent is a paywalled HTTP endpoint at /api/v1/<slug>. POST without payment to get a 402 challenge, sign the prepared Soroban XDR with any Stellar Wallets Kit wallet (Freighter, LOBSTR, Albedo, xBull, Rabet), submit, then retry with the X-PAYMENT receipt.`,
    code: `# 1. Get the 402 challenge
curl -i -X POST ${API}/api/v1/translator-en-vi \\
  -H 'content-type: application/json' \\
  -H 'x-stellar-address: G…' \\
  -H 'x-payment-mode: public' \\
  -d '{"question":"Translate: ..."}'

# 2. Sign the prepared tx in the wallet, submit via Soroban RPC.
# 3. Retry with:
#      x-payment: stellar <tx_hash>
#      x-payment-nonce: <nonce from step 1>`,
  },
  {
    id: 'private',
    title: 'Private payment tier',
    body: `Add x-payment-mode: private. The 402 challenge stays HTTP-native; the amount is multiplied by PRIVATE_TIER_MULTIPLIER (default 1.5×). v3.0.0 routes through a semi-trusted platform-relay (atomic 2-op Soroban tx) that breaks the buyer↔agent linkage on-chain. v3.1 swaps the second op for a Groth16 privacy-pool transfer behind the same API surface.`,
    code: `# Step 1 — 402 challenge in private mode
curl -i -X POST ${API}/api/v1/translator-en-vi \\
  -H 'content-type: application/json' \\
  -H 'x-stellar-address: G…' \\
  -H 'x-payment-mode: private' \\
  -d '{"question":"..."}'

# Step 2 — build the platform-relay XDR
curl -X POST ${API}/v3/marketplace/seller/agent/<agent_id>/build-hire-xdr \\
  -H 'content-type: application/json' \\
  -H 'x-stellar-address: G…' \\
  -d '{"payment_mode":"private","nonce":"<nonce from step 1>"}'

# Step 3 — wallet co-signs the returned XDR, POST to /v3/marketplace/submit,
# then retry Step 1 with x-payment: stellar <tx_hash>.`,
  },
  {
    id: 'mint-curl',
    title: 'Mint via cURL (programmatic)',
    body: `The form above is the same /v3/concierge/onboard endpoint your CI can call. Returns status: live | needs_clarification | duplicate. Idempotent on slug.`,
    code: `curl -X POST ${API}/v3/concierge/onboard \\
  -H 'content-type: application/json' \\
  -d '{
    "prompt": "My agent translates English legal documents into Vietnamese, $0.05 per query, hosted at https://my-translator.example.com/api.",
    "operator_email": "you@example.com"
  }'`,
  },
  {
    id: 'topup',
    title: 'Top up USDC with fiat',
    body: `POST /api/v1/credits/buy-pack-{usd} with a Stellar address. The API mints a Coinflow SEP-24 session; the buyer pays by SEPA / Card / Apple Pay in the hosted iframe. USDC lands in ≤15s.`,
    code: `curl -X POST ${API}/api/v1/credits/buy-pack-25 \\
  -H 'content-type: application/json' \\
  -d '{"stellar_address":"G…"}'`,
  },
];

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-3xl font-bold">Docs</h1>
        <p className="text-on-surface-variant">
          OpenX-S is a single-chain agent marketplace on Stellar.{' '}
          <Link
            href="https://stellar.expert/explorer/testnet"
            target="_blank"
            className="text-primary-container hover:underline"
          >
            Stellar Expert ↗
          </Link>
        </p>
      </header>

      {/* Mint — interactive */}
      <MintForm />

      {/* Reference index */}
      <nav className="flex flex-wrap gap-2 text-sm">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full border border-outline-variant/60 px-3 py-1 text-on-surface-variant hover:border-primary-container"
          >
            {s.title}
          </a>
        ))}
      </nav>

      {SECTIONS.map((s) => (
        <section
          key={s.id}
          id={s.id}
          className="scroll-mt-24 space-y-3 rounded-xl border border-outline-variant/40 bg-surface-container-low p-6"
        >
          <h2 className="text-xl font-semibold">{s.title}</h2>
          <p className="whitespace-pre-line text-sm text-on-surface-variant">{s.body}</p>
          <pre className="overflow-x-auto rounded-lg bg-black/40 p-4 font-mono text-xs text-primary-container">
            {s.code}
          </pre>
        </section>
      ))}

      <p className="pt-4 text-center text-sm text-on-surface-variant/70">
        Full reference at{' '}
        <Link href={`${API}/openapi.json`} target="_blank" className="text-primary-container hover:underline">
          /openapi.json
        </Link>
        .
      </p>
    </div>
  );
}
