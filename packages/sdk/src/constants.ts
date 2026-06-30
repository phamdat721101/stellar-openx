/**
 * Stellar network constants.
 *
 * Single source of truth for network ids, RPC endpoints, and the canonical
 * Stellar USDC SAC (Stellar Asset Contract) ids. Anyone reading the chain
 * (API, frontend, smokes) imports from here so swaps stay surgical.
 */

export const STELLAR_NETWORK = {
  TESTNET: 'testnet',
  MAINNET: 'mainnet',
} as const;
export type StellarNetwork = (typeof STELLAR_NETWORK)[keyof typeof STELLAR_NETWORK];

export const STELLAR_RPC_URLS: Record<StellarNetwork, string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://soroban-rpc.creit.tech',
};

export const STELLAR_HORIZON_URLS: Record<StellarNetwork, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
};

/**
 * USDC Stellar Asset Contract ids. Source: Circle docs.
 *   testnet: USDC issued by Circle (TEST issuer GCKFBEIYTKP74Q...).
 *   mainnet: USDC issued by Circle (GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN).
 *
 * The SAC id is the wrapped Soroban contract for the underlying asset; pass
 * this to the `token::Client` in our Soroban contracts and to the
 * `Contract.call` helpers in the API.
 */
export const STELLAR_USDC_SAC: Record<StellarNetwork, string> = {
  testnet: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  mainnet: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
};

/**
 * Stroops per USDC. Stellar uses 7-decimal accounting natively; the USDC SAC
 * follows the same convention. 1.50 USDC = 15_000_000 stroops.
 */
export const STROOPS_PER_USDC = 10_000_000n;

/** USDC display → stroops bigint. Truncates at 7 decimals. */
export function usdcToStroops(amount: string | number): bigint {
  const [whole, frac = ''] = String(amount).split('.');
  const padded = (frac + '0000000').slice(0, 7);
  return BigInt(whole) * STROOPS_PER_USDC + BigInt(padded || '0');
}

/** Stroops bigint → USDC display string with up to 7 decimals (trims zeros). */
export function stroopsToUsdc(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_USDC;
  const frac = stroops % STROOPS_PER_USDC;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(7, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}
