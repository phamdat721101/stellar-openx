/**
 * stellar/privacyPool.ts — TS wrapper for the privacy-pool Soroban contract.
 *
 * Used by the premium "Private" payment tier. The buyer flow is:
 *   1. One-time deposit:   buyer signs deposit(amount, commitment).
 *   2. Per-call:           buyer signs private_transfer(proof, public_inputs)
 *                          to spend a note into a new commitment matching the
 *                          agent's payout pubkey hash.
 *   3. Agent withdraws:    agent (or platform on the agent's behalf) submits
 *                          withdraw() with the consumed nullifier.
 *
 * v3.0.0 scope: this module exposes only XDR builders. Proof generation is
 * delegated to the buyer's wallet (Nethermind reference toolchain); the API
 * never sees a witness.
 */

import { Address, Contract, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { getStellar } from './client';

export interface PrivateTransferInputs {
  proofBytes: Buffer;
  publicInputs: Buffer[]; // 32-byte chunks: [new_commitment, nullifier_in, merkle_root]
}

export async function buildDepositXdr(
  buyer: string,
  amountStroops: bigint,
  commitment: Buffer,
): Promise<string> {
  const s = getStellar();
  if (!s.contracts.privacyPool) throw new Error('privacy-pool not deployed');
  const tx = (await s.buildTx(buyer))
    .addOperation(
      new Contract(s.contracts.privacyPool).call(
        'deposit',
        new Address(buyer).toScVal(),
        nativeToScVal(amountStroops, { type: 'i128' }),
        nativeToScVal(commitment, { type: 'bytes' }),
      ),
    )
    .build();
  return (await s.rpc.prepareTransaction(tx)).toXDR();
}

export async function buildPrivateTransferXdr(
  caller: string,
  inputs: PrivateTransferInputs,
): Promise<string> {
  const s = getStellar();
  if (!s.contracts.privacyPool) throw new Error('privacy-pool not deployed');
  const tx = (await s.buildTx(caller))
    .addOperation(
      new Contract(s.contracts.privacyPool).call(
        'private_transfer',
        nativeToScVal(inputs.proofBytes, { type: 'bytes' }),
        xdr.ScVal.scvVec(
          inputs.publicInputs.map((b) => nativeToScVal(b, { type: 'bytes' })),
        ),
      ),
    )
    .build();
  return (await s.rpc.prepareTransaction(tx)).toXDR();
}

export async function buildWithdrawXdr(
  recipient: string,
  amountStroops: bigint,
  nullifier: Buffer,
  proofBytes: Buffer,
  publicInputs: Buffer[],
): Promise<string> {
  const s = getStellar();
  if (!s.contracts.privacyPool) throw new Error('privacy-pool not deployed');
  const tx = (await s.buildTx(recipient))
    .addOperation(
      new Contract(s.contracts.privacyPool).call(
        'withdraw',
        new Address(recipient).toScVal(),
        nativeToScVal(amountStroops, { type: 'i128' }),
        nativeToScVal(nullifier, { type: 'bytes' }),
        nativeToScVal(proofBytes, { type: 'bytes' }),
        xdr.ScVal.scvVec(
          publicInputs.map((b) => nativeToScVal(b, { type: 'bytes' })),
        ),
      ),
    )
    .build();
  return (await s.rpc.prepareTransaction(tx)).toXDR();
}
