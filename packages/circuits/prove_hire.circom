pragma circom 2.1.5;

/*
 * prove_hire.circom — OpenX ZK private-hire attestation.
 *
 * Proves: "I know a (secret, nonce) pair whose Poseidon commitment matches
 * the public commitment, and this proof is bound to the specified agent."
 *
 *   commitment  = Poseidon(secret, nonce)
 *   agent_bind  = Poseidon(commitment, agent_id)
 *
 * Public inputs:  commitment, agent_bind, agent_id
 * Private inputs: secret, nonce
 *
 * Privacy property: verifier learns nothing about secret/nonce. Reusing the
 * same commitment for a different agent produces a different agent_bind,
 * so proofs are not replayable across agents.
 */

include "../node_modules/circomlib/circuits/poseidon.circom";

template ProveHire() {
    signal input secret;
    signal input nonce;
    signal input agent_id;

    signal output commitment;
    signal output agent_bind;

    component h1 = Poseidon(2);
    h1.inputs[0] <== secret;
    h1.inputs[1] <== nonce;
    commitment <== h1.out;

    component h2 = Poseidon(2);
    h2.inputs[0] <== commitment;
    h2.inputs[1] <== agent_id;
    agent_bind <== h2.out;
}

component main {public [agent_id]} = ProveHire();
