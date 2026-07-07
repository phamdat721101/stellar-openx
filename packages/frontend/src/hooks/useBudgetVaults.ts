'use client';

/**
 * useBudgetVaults — single source of truth for the buyer-side BudgetVault
 * dashboard. Owns fetch + refresh + mutation orchestration; components
 * render pure JSX from the returned state.
 *
 * SOLID:
 *   • SRP — this hook owns *only* the vault list + mutations for the
 *     connected wallet. Chain signing lives in `useStellarWallet`.
 *   • DIP — depends on `fetch(API_URL)` + `useStellarWallet.signTransaction`;
 *     both swappable at the callsite.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '@/lib/stellar';
import { useStellarWallet } from './useStellarWallet';

export interface BudgetVault {
  id: string;
  buyer_address: string;
  contract_address: string;
  asset_code: string;
  sac_contract: string;
  network: 'testnet' | 'mainnet';
  total_cap: string | null;
  per_hire_cap: string | null;
  allowlist_mode: 'any' | 'slugs' | 'sellers';
  allowlist: string[];
  balance_cache: string | null;
  total_spent: string;
  hire_count: number;
  status: 'deploying' | 'active' | 'paused' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface DeployVaultInput {
  asset_code: string;
  initial_deposit: string;
  total_cap?: string;
  per_hire_cap?: string;
  allowlist_mode: 'any' | 'slugs' | 'sellers';
  allowlist: string[];
}

interface State {
  vaults: BudgetVault[];
  loading: boolean;
  error: string | null;
}

export interface YieldSummary {
  total_earned_stroops: string;
  this_month_stroops: string;
  active_vaults_with_boost: number;
  next_epoch_at: string;
  base_apy_bp: number;
  boost_apy_bp: number;
  boost_days: number;
}

const POLL_MS = 30_000;
const YIELD_ENABLED = process.env.NEXT_PUBLIC_FEATURE_M2_VAULT_YIELD === 'true';

export function useBudgetVaults() {
  const { address, signTransaction } = useStellarWallet();
  const [state, setState] = useState<State>({ vaults: [], loading: false, error: null });
  const [yieldSummary, setYieldSummary] = useState<YieldSummary | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!address) { setState({ vaults: [], loading: false, error: null }); setYieldSummary(null); return; }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [vaultsRes, yieldRes] = await Promise.all([
        fetch(`${API_URL}/v3/marketplace/budget/me`, {
          headers: { 'x-stellar-address': address },
          signal: ac.signal,
        }),
        YIELD_ENABLED
          ? fetch(`${API_URL}/v3/marketplace/budget/rewards/summary`, {
              headers: { 'x-stellar-address': address },
              signal: ac.signal,
            }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!vaultsRes.ok) {
        if (vaultsRes.status === 404) { setState({ vaults: [], loading: false, error: null }); return; }
        throw new Error(`GET /budget/me → ${vaultsRes.status}`);
      }
      const j = (await vaultsRes.json()) as { vaults: BudgetVault[] };
      setState({ vaults: j.vaults ?? [], loading: false, error: null });
      if (yieldRes && yieldRes.ok) {
        const y = (await yieldRes.json()) as { data: YieldSummary };
        setYieldSummary(y.data ?? null);
      } else {
        setYieldSummary(null);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
    }
  }, [address]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while tab visible.
  useEffect(() => {
    if (!address) return;
    const tick = () => { if (document.visibilityState === 'visible') void refresh(); };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [address, refresh]);

  // ── Mutations ────────────────────────────────────────────────────────────

  async function apiPost<T>(path: string, body: unknown): Promise<T> {
    if (!address) throw new Error('wallet not connected');
    const r = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stellar-address': address },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }

  const deploy = useCallback(async (input: DeployVaultInput) => {
    // Step 1: deploy contract (sig 1)
    const build = await apiPost<{
      vault_placeholder_id: string;
      contract_address: string;
      deploy_xdr: string;
    }>('/v3/marketplace/budget/deploy', input);
    const signedDeploy = await signTransaction(build.deploy_xdr);
    const deploySubmit = await apiPost<{ tx_hash: string; contract_id?: string }>(
      '/v3/marketplace/submit', { signed_xdr: signedDeploy },
    );
    // Step 2: server rebuilds init_xdr from the placeholder row (contract
    // now exists on-chain), buyer signs (sig 2), we submit + confirm.
    const init = await apiPost<{ init_xdr: string }>(
      `/v3/marketplace/budget/${build.vault_placeholder_id}/init`,
      { contract_address: deploySubmit.contract_id },
    );
    const signedInit = await signTransaction(init.init_xdr);
    const initSubmit = await apiPost<{ tx_hash: string }>(
      '/v3/marketplace/submit', { signed_xdr: signedInit },
    );
    await apiPost('/v3/marketplace/budget/confirm-deploy', {
      vault_placeholder_id: build.vault_placeholder_id,
      tx_hash: initSubmit.tx_hash,
    });
    await refresh();
    return build.contract_address;
  }, [address, signTransaction, refresh]);

  const _signAndSubmit = async (buildPath: string, buildBody: unknown, refreshPath?: string) => {
    const b = await apiPost<{ xdr: string; contract_address: string }>(buildPath, buildBody);
    const signed = await signTransaction(b.xdr);
    await apiPost('/v3/marketplace/submit', { signed_xdr: signed });
    if (refreshPath) await apiPost(refreshPath, {}).catch(() => undefined);
    await refresh();
  };

  const topup = useCallback((vaultId: string, amount: string) =>
    _signAndSubmit(`/v3/marketplace/budget/${vaultId}/topup`, { amount }, `/v3/marketplace/budget/${vaultId}/refresh`),
    [refresh, signTransaction],
  );

  const withdraw = useCallback((vaultId: string, amount: string) =>
    _signAndSubmit(`/v3/marketplace/budget/${vaultId}/withdraw`, { amount }, `/v3/marketplace/budget/${vaultId}/refresh`),
    [refresh, signTransaction],
  );

  const setAllowlist = useCallback((vaultId: string, mode: 'any' | 'slugs' | 'sellers', slugs: string[], sellers: string[]) =>
    _signAndSubmit(`/v3/marketplace/budget/${vaultId}/allowlist`, { mode, slugs, sellers }),
    [refresh, signTransaction],
  );

  const setStatus = useCallback((vaultId: string, status: 'active' | 'paused' | 'closed') =>
    _signAndSubmit(`/v3/marketplace/budget/${vaultId}/status`, { status }),
    [refresh, signTransaction],
  );

  return { ...state, refresh, deploy, topup, withdraw, setAllowlist, setStatus, yieldSummary };
}
