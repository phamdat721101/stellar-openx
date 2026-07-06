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
 * MGUSD SEP-41 SACs — MoneyGram × M0 stablecoin.
 * Source (M0 canonical): https://docs.m0.org/resources/addresses/mgusd-platform
 *
 * Asset codes: testnet uses `TMGUSD`, mainnet uses `MGUSD`. Both are
 * 7-decimal SEP-41 compliant — same stroop math as USDC.
 */
export const STELLAR_MGUSD_SAC: Record<StellarNetwork, string> = {
  testnet: 'CCWJCHDLXEIMXODO5JFZLRUM7AMA7EI2NBRBL44ROCL6WH44W22NM7HM',
  mainnet: 'CDK2LDSYUKPEFN3HNE7K7ETUT3VIOBHSOXAK5CTO4A4RKKZQUCAIWCJA',
};
export const STELLAR_MGUSD_CODE: Record<StellarNetwork, string> = {
  testnet: 'TMGUSD',
  mainnet: 'MGUSD',
};

/** All SEP-41 assets known to the SDK. Extend here when adding new stablecoins. */
export const STELLAR_KNOWN_ASSETS: Record<StellarNetwork, Record<string, string>> = {
  testnet: {
    USDC: STELLAR_USDC_SAC.testnet,
    TMGUSD: STELLAR_MGUSD_SAC.testnet,
  },
  mainnet: {
    USDC: STELLAR_USDC_SAC.mainnet,
    MGUSD: STELLAR_MGUSD_SAC.mainnet,
  },
};

/**
 * Stroops per USDC. Stellar uses 7-decimal accounting natively; the USDC SAC
 * follows the same convention. 1.50 USDC = 15_000_000 stroops.
 *
 * Same math applies to MGUSD (also 7-decimal SEP-41).
 */
export const STROOPS_PER_USDC = 10_000_000n;
/** Alias for readability when working with non-USDC 7-decimal assets. */
export const STROOPS_PER_ASSET = STROOPS_PER_USDC;

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
