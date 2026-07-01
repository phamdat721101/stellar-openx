/**
 * stellar/privacyPool.ts — glue to Nethermind's audited Privacy Pool.
 *
 * We do NOT own the pool. It, its ASP trees, and the Groth16 verifier are
 * external cross-contracts deployed by Nethermind (see
 * docs/runbooks/ZK_DEPLOY.md for addresses). This module's job is:
 *   1. Take a JSON proof + ext_data emitted by the buyer's browser SDK.
 *   2. Encode them to the ScVal shapes the pool contract expects.
 *   3. Build a `pool.transact(proof, ext_data, sender)` XDR, simulate to
 *      populate the Soroban footprint, return XDR for the wallet to sign.
 *
 * SOLID:
 *  - SRP: this file only translates JSON → ScVal → prepared XDR. Proof gen
 *    lives in the SDK (browser). Verification lives in Nethermind's audited
 *    verifier binary. Ledger + splits stay in paid-call-ledger.
 *  - DIP: `getStellar()` supplies the pool address + RPC — swappable for tests.
 */

import { Address, Contract, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { getStellar } from './client';

/**
 * JSON shape emitted by `@openx/sdk` — mirrors Nethermind's on-chain
 * `Proof` contracttype (see NethermindEth/stellar-private-payments
 * contracts/pool/src/pool.rs). All U256 fields are 32-byte big-endian hex.
 */
export interface PoolProofJson {
  /** snarkjs Groth16 proof — pi_a/pi_b/pi_c as decimal strings. */
  proof: {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
  };
  root: string;
  input_nullifiers: string[];
  output_commitment0: string;
  output_commitment1: string;
  public_amount: string;
  /** 32-byte hex — matches `hashExtData(...)` output. */
  ext_data_hash: string;
  asp_membership_root: string;
  asp_non_membership_root: string;
}

export interface ExtDataJson {
  recipient: string;
  /** Signed decimal string ("100000" deposit, "-100000" withdraw). */
  ext_amount: string;
  encrypted_output0: string; // hex
  encrypted_output1: string; // hex
}

export interface BuildTransactXdrArgs {
  sender: string;
  proof: PoolProofJson;
  extData: ExtDataJson;
}

/**
 * Build the `pool.transact` XDR envelope. Buyer or seller signs the returned
 * base64 XDR; the API's `/submit` route broadcasts it.
 */
export async function buildTransactXdr({
  sender,
  proof,
  extData,
}: BuildTransactXdrArgs): Promise<string> {
  const s = getStellar();
  if (!s.contracts.privacyPool) throw new Error('privacyPool: STELLAR_PRIVACY_POOL_ID not set');

  const tx = (await s.buildTx(sender))
    .addOperation(
      new Contract(s.contracts.privacyPool).call(
        'transact',
        proofToScVal(proof),
        extDataToScVal(extData),
        new Address(sender).toScVal(),
      ),
    )
    .build();
  const prepared = await s.rpc.prepareTransaction(tx);
  return prepared.toXDR();
}

// ─── ScVal encoders (mirror Nethermind on-chain shapes) ──────────────────

function proofToScVal(p: PoolProofJson): xdr.ScVal {
  // ScMap keys must be sorted lexicographically (Soroban serialisation rule).
  return xdr.ScVal.scvMap([
    entry('asp_membership_root', hexToU256(p.asp_membership_root)),
    entry('asp_non_membership_root', hexToU256(p.asp_non_membership_root)),
    entry('ext_data_hash', xdr.ScVal.scvBytes(Buffer.from(strip0x(p.ext_data_hash), 'hex'))),
    entry(
      'input_nullifiers',
      xdr.ScVal.scvVec(p.input_nullifiers.map(hexToU256)),
    ),
    entry('output_commitment0', hexToU256(p.output_commitment0)),
    entry('output_commitment1', hexToU256(p.output_commitment1)),
    entry('proof', groth16ProofToScVal(p.proof)),
    entry('public_amount', hexToU256(p.public_amount)),
    entry('root', hexToU256(p.root)),
  ]);
}

function extDataToScVal(e: ExtDataJson): xdr.ScVal {
  return xdr.ScVal.scvMap([
    entry(
      'encrypted_output0',
      xdr.ScVal.scvBytes(Buffer.from(strip0x(e.encrypted_output0), 'hex')),
    ),
    entry(
      'encrypted_output1',
      xdr.ScVal.scvBytes(Buffer.from(strip0x(e.encrypted_output1), 'hex')),
    ),
    entry('ext_amount', nativeToScVal(BigInt(e.ext_amount), { type: 'i256' })),
    entry('recipient', new Address(e.recipient).toScVal()),
  ]);
}

/**
 * snarkjs → Nethermind Groth16Proof ScVal. The shape assumed here is the
 * conventional 3-field struct (a: 64B, b: 128B, c: 64B) that the reference
 * `CircomGroth16Verifier` uses. If Nethermind pins a different field order
 * or splits G1/G2 differently, adjust this one function — the rest of the
 * pipeline is shape-agnostic. Verified by the smoke suite against the live
 * verifier.
 */
function groth16ProofToScVal(p: PoolProofJson['proof']): xdr.ScVal {
  const a = concatFieldBytes([p.pi_a[0], p.pi_a[1]]);           // 64 B
  const b = concatFieldBytes([
    // BN254 G2: (c0, c1) per coordinate — snarkjs orders as [c1, c0].
    p.pi_b[0][1], p.pi_b[0][0],
    p.pi_b[1][1], p.pi_b[1][0],
  ]);                                                            // 128 B
  const c = concatFieldBytes([p.pi_c[0], p.pi_c[1]]);           // 64 B
  return xdr.ScVal.scvMap([
    entry('a', xdr.ScVal.scvBytes(a)),
    entry('b', xdr.ScVal.scvBytes(b)),
    entry('c', xdr.ScVal.scvBytes(c)),
  ]);
}

function concatFieldBytes(decimals: string[]): Buffer {
  return Buffer.concat(decimals.map((d) => Buffer.from(bigintToPaddedHex(BigInt(d), 32), 'hex')));
}

function hexToU256(hex: string): xdr.ScVal {
  const clean = strip0x(hex);
  const padded = clean.padStart(64, '0');
  return nativeToScVal(BigInt('0x' + padded), { type: 'u256' });
}

function bigintToPaddedHex(n: bigint, byteLen: number): string {
  return n.toString(16).padStart(byteLen * 2, '0');
}

function strip0x(s: string): string {
  return s.startsWith('0x') ? s.slice(2) : s;
}

function entry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}
