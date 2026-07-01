/**
 * @openx/sdk/zk/extData — ExtData builder + `hash_ext_data` (browser + node).
 *
 * Bit-for-bit compatible with the Rust hash in Nethermind's
 * `contracts/pool/src/pool.rs::hash_ext_data`:
 *
 *   keccak256( ExtData.toXDR() )  mod  bn254_scalar_field
 *
 * The Soroban host serialises a `contracttype` struct as an ScMap with
 * lexicographically-sorted symbol keys, so we do exactly the same on the
 * client side. Any drift here becomes an on-chain `WrongExtHash` error.
 *
 * SOLID: one concern (ExtData ↔ 32-byte field element). No IO, no crypto
 * beyond keccak-mod; safe to import from browser + Node + tests.
 */

import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { keccak_256 } from 'js-sha3';

/** BN254 scalar field size — the Groth16 public-input modulus. */
export const BN254_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Deterministic slug → BN254 field element. Uses first 31 bytes of
 * Keccak256(slug) so the value is always < BN254_SCALAR_FIELD.
 * Server mirrors this in `services/zk/verifier::agentIdFieldForSlug`.
 */
export function hireAgentIdField(slug: string): bigint {
  const digest = keccak_256.arrayBuffer(slug);
  const bytes = new Uint8Array(digest).subarray(0, 31);
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

/**
 * Draw a fresh 248-bit random scalar suitable as circuit private input.
 * Uses the WebCrypto RNG available on both modern browsers and Node ≥ 20.
 */
export function randomScalar248(): bigint {
  const buf = new Uint8Array(31);
  crypto.getRandomValues(buf);
  let out = 0n;
  for (const b of buf) out = (out << 8n) | BigInt(b);
  return out;
}

export interface ExtDataInput {
  /** Recipient G… (deposit → pool, withdraw → payee, transfer → sentinel). */
  recipient: string;
  /** Positive → deposit, negative → withdrawal, zero → pure transfer. */
  extAmount: bigint;
  /** Encrypted note blob for output UTXO 0 (opaque to chain, decrypted by receiver). */
  encryptedOutput0: Uint8Array;
  /** Encrypted note blob for output UTXO 1. */
  encryptedOutput1: Uint8Array;
}

/**
 * Build the ScVal.map that mirrors the on-chain `ExtData` layout. Exposed so
 * callers can `.toXDR()` when they need the raw XDR envelope (e.g. to feed
 * into `pool.transact` as an argument alongside the ScVal proof).
 */
export function extDataToScVal(input: ExtDataInput): xdr.ScVal {
  // Field order MUST be alphabetical — matches Soroban's ScMap encoding.
  return xdr.ScVal.scvMap([
    entry('encrypted_output0', xdr.ScVal.scvBytes(Buffer.from(input.encryptedOutput0))),
    entry('encrypted_output1', xdr.ScVal.scvBytes(Buffer.from(input.encryptedOutput1))),
    entry('ext_amount', nativeToScVal(input.extAmount, { type: 'i256' })),
    entry('recipient', new Address(input.recipient).toScVal()),
  ]);
}

/**
 * Compute the `ext_data_hash` public input for the ZK circuit.
 *
 * Returns a 32-byte big-endian buffer already reduced modulo BN254 scalar
 * field — matches Rust `hash_ext_data`'s post-reduction output verbatim.
 */
export function hashExtData(input: ExtDataInput): Uint8Array {
  const bytes = extDataToScVal(input).toXDR();
  const digest = keccak_256.arrayBuffer(bytes);
  const reduced = bytesToBigInt(new Uint8Array(digest)) % BN254_SCALAR_FIELD;
  return bigIntTo32Bytes(reduced);
}

// ── helpers ────────────────────────────────────────────────────────────────

function entry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

function bytesToBigInt(b: Uint8Array): bigint {
  let out = 0n;
  for (const byte of b) out = (out << 8n) | BigInt(byte);
  return out;
}

function bigIntTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
