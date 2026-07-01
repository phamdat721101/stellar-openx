/**
 * services/zk/verifier — server-side Groth16 proof verification.
 *
 * Buyers generate real Circom Groth16 proofs in the browser (via @openx/sdk).
 * This module verifies them here before allowing the private-tier settlement
 * to complete. On-chain verification (Path B, deploy own verifier contract)
 * is the v3.4 upgrade — same proof, same vk, different point of verification.
 *
 * SOLID:
 *  - SRP: one job — validate a `(publicSignals, proof)` pair against the
 *    committed vk. No IO except the one-time vk load at boot.
 *  - DIP: vk lives as a JSON asset next to this file; can be swapped by
 *    dropping a new file (no code change) — matches the runbook operator flow.
 */

import { keccak_256 } from 'js-sha3';
import verificationKey from './verification_key.json';

/** BN254 scalar field r — proofs public inputs must reduce mod r. */
const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let vkCache: unknown | null = null;
function loadVk(): unknown {
  // Imported statically at module load; tsc bundles the JSON into the compiled
  // JS thanks to resolveJsonModule. No filesystem hit at runtime — works
  // identically in dev (source), local `tsc` output, and the Docker image.
  if (!vkCache) vkCache = verificationKey;
  return vkCache;
}

export interface ProofBundle {
  proof: {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
    protocol: 'groth16';
    curve: 'bn128';
  };
  publicSignals: string[]; // [commitment, agent_bind, agent_id]
}

export interface VerifyOptions {
  /** Slug of the agent this proof is expected to bind to. */
  expectedAgentSlug: string;
}

/**
 * Verify a Groth16 hire proof.
 *
 * Success criteria (all must hold):
 *  1. Groth16 verify returns true against the committed vk.
 *  2. publicSignals[2] equals the deterministic agent_id field element
 *     derived from the slug — proves the proof is bound to THIS agent.
 *  3. publicSignals[0] (commitment) and [1] (agent_bind) are canonical field
 *     elements (< BN254_R).
 */
export async function verifyHireProof(
  bundle: ProofBundle,
  opts: VerifyOptions,
): Promise<{ ok: true; commitment: string } | { ok: false; reason: string }> {
  const { proof, publicSignals } = bundle;
  if (!Array.isArray(publicSignals) || publicSignals.length !== 3) {
    return { ok: false, reason: 'malformed publicSignals' };
  }
  const commitment = BigInt(publicSignals[0]);
  const agentBind = BigInt(publicSignals[1]);
  const agentIdField = BigInt(publicSignals[2]);
  if (commitment >= BN254_R || agentBind >= BN254_R || agentIdField >= BN254_R) {
    return { ok: false, reason: 'public input out of field' };
  }

  const expectedAgentIdField = agentIdFieldForSlug(opts.expectedAgentSlug);
  if (agentIdField !== expectedAgentIdField) {
    return { ok: false, reason: 'proof not bound to this agent' };
  }

  const snarkjs = await import('snarkjs');
  const ok = await snarkjs.groth16.verify(
    loadVk() as never,
    publicSignals,
    proof as never,
  );
  if (!ok) return { ok: false, reason: 'groth16 verification failed' };
  return { ok: true, commitment: publicSignals[0] };
}

/**
 * Deterministic mapping slug → field element. Uses the first 31 bytes of
 * Keccak256(slug) so the value is always < BN254_R. Symmetric with the FE
 * derivation in `packages/sdk/src/zk/extData.ts::hireAgentIdField`.
 */
export function agentIdFieldForSlug(slug: string): bigint {
  const digest = keccak_256.arrayBuffer(slug);
  const bytes = new Uint8Array(digest).subarray(0, 31); // 248 bits < BN254_R
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}
