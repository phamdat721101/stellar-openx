/**
 * @openx/sdk/zk — ZK Privacy Pool client helpers.
 *
 * Three tight modules:
 *  - extData    : ExtData builder + `hash_ext_data` (chain-compatible)
 *  - noteStore  : IndexedDB UTXO cache (browser) / in-memory (node)
 *  - prover     : snarkjs Groth16 wrapper
 *
 * Import surface deliberately narrow — consumers only need these named
 * exports; snarkjs stays lazy-loaded until first `prove()` call.
 */

export * from './extData';
export * from './noteStore';
export * from './prover';
