/**
 * stellar/client.ts — process-wide Stellar SDK singleton.
 */

import {
  Keypair,
  Networks,
  rpc as stellarRpcNs,
  TransactionBuilder,
  TimeoutInfinite,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { STELLAR_NETWORK, STELLAR_RPC_URLS, STELLAR_USDC_SAC, type StellarNetwork } from '@openx/sdk';

export interface StellarHandle {
  readonly network: StellarNetwork;
  readonly passphrase: string;
  readonly rpc: stellarRpcNs.Server;
  readonly platformKeypair: Keypair;
  readonly usdcSacId: string;
  readonly contracts: {
    agentRegistry: string;
    paywallRouter: string;
    paidCallLedger: string;
    privacyPool: string;
    privacyPoolToken: string;
    aspMembership: string;
    aspNonMembership: string;
    groth16Verifier: string;
  };
  submitPlatformSigned(tx: Transaction): Promise<{
    hash: string;
    ledger?: number;
    /** ScVal returned by the invoked contract method; undefined for non-invoke ops. */
    returnValue?: xdr.ScVal;
  }>;
  buildTx(source: string): Promise<TransactionBuilder>;
}

let cached: StellarHandle | null = null;

export function getStellar(): StellarHandle {
  if (cached) return cached;
  const network = (process.env.STELLAR_NETWORK ?? STELLAR_NETWORK.TESTNET) as StellarNetwork;
  const rpcUrl = process.env.STELLAR_RPC_URL ?? STELLAR_RPC_URLS[network];
  const passphrase = network === STELLAR_NETWORK.MAINNET ? Networks.PUBLIC : Networks.TESTNET;

  const secret = process.env.STELLAR_PLATFORM_SECRET_KEY;
  if (!secret) throw new Error('stellar:client: STELLAR_PLATFORM_SECRET_KEY is required');
  const platformKeypair = Keypair.fromSecret(secret);
  const stellarRpc = new stellarRpcNs.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

  const contracts = {
    agentRegistry: requireEnv('STELLAR_AGENT_REGISTRY_ID'),
    paywallRouter: requireEnv('STELLAR_PAYWALL_ROUTER_ID'),
    paidCallLedger: requireEnv('STELLAR_PAID_CALL_LEDGER_ID'),
    privacyPool: process.env.STELLAR_PRIVACY_POOL_ID ?? '',
    privacyPoolToken: process.env.STELLAR_PRIVACY_POOL_TOKEN_ID ?? '',
    aspMembership: process.env.STELLAR_ASP_MEMBERSHIP_ID ?? '',
    aspNonMembership: process.env.STELLAR_ASP_NON_MEMBERSHIP_ID ?? '',
    groth16Verifier: process.env.STELLAR_GROTH16_VERIFIER_ID ?? '',
  };

  const submitPlatformSigned = async (tx: Transaction) => {
    const send = await stellarRpc.sendTransaction(tx);
    if (send.status === 'ERROR') throw new Error(`stellar:submit:${send.errorResult}`);
    let attempt = 0;
    while (attempt < 30) {
      const r = await stellarRpc.getTransaction(send.hash);
      if (r.status === 'SUCCESS') {
        return { hash: send.hash, ledger: r.ledger, returnValue: r.returnValue };
      }
      if (r.status === 'FAILED') throw new Error(`stellar:tx:failed:${send.hash}`);
      await new Promise((res) => setTimeout(res, 1_000));
      attempt += 1;
    }
    throw new Error(`stellar:tx:timeout:${send.hash}`);
  };

  const buildTx = async (source: string): Promise<TransactionBuilder> => {
    const account = await stellarRpc.getAccount(source);
    return new TransactionBuilder(account, {
      fee: '1000000',
      networkPassphrase: passphrase,
    }).setTimeout(TimeoutInfinite);
  };

  cached = Object.freeze<StellarHandle>({
    network,
    passphrase,
    rpc: stellarRpc,
    platformKeypair,
    usdcSacId: process.env.STELLAR_USDC_SAC_ID ?? STELLAR_USDC_SAC[network],
    contracts,
    submitPlatformSigned,
    buildTx,
  });
  return cached;
}

export function setStellarForTest(handle: StellarHandle): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setStellarForTest is test-only');
  }
  cached = handle;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`stellar:client: ${name} required`);
  return v;
}
