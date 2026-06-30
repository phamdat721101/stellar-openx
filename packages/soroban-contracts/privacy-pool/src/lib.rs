//! privacy-pool — Nethermind-style Privacy Pool, slimmed for OpenX-S v3.0.0.
//!
//! Buyers deposit USDC publicly, transfer privately by submitting a Groth16
//! proof verified against an *external* groth16-verifier contract
//! (`NethermindEth/stellar-risc0-verifier`, deployed as an audited binary —
//! not in this repo). Withdrawals consume one nullifier per shielded note.
//!
//! v3.0.0 scope (matches PRD-S NG-3):
//! - USDC-only (single Stellar Asset Contract).
//! - Strict allowlist (admin curates membership; matches Nethermind ASP).
//! - Per-deposit cap of 10 USDC (testnet safety while unaudited).
//! - Real proof verification is delegated to the external verifier contract
//!   so this contract has no cryptographic surface of its own.
//!
//! SOLID:
//! - SRP: this contract owns the deposit ledger + nullifier set + asset
//!   custody. Proof verification is *not* its job (DIP via the verifier
//!   client). When the external verifier accepts, we settle; otherwise we
//!   abort.

#![no_std]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, contracterror, panic_with_error,
    symbol_short, token, Address, Bytes, BytesN, Env, Symbol, Vec,
};

pub const MAX_DEPOSIT_STROOPS: i128 = 100_000_000; // 10 USDC

#[contracttype]
pub enum DataKey {
    Admin,
    UsdcSac,
    Verifier,                       // external groth16-verifier contract id
    Commitment(BytesN<32>),         // commitment hash -> amount stroops (deposit-time)
    Nullifier(BytesN<32>),          // spent nullifier set (presence = spent)
    Allow(Address),                 // allowlist membership (admin curated)
    Deny(Address),                  // denylist (sanctioned)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    NotAllowlisted = 4,
    Denylisted = 5,
    DepositTooLarge = 6,
    DuplicateCommitment = 7,
    NullifierSpent = 8,
    InvalidProof = 9,
    InsufficientPool = 10,
    InvalidAmount = 11,
}

const EV_DEPOSIT: Symbol = symbol_short!("deposit");
const EV_TRANSFER: Symbol = symbol_short!("transfer");
const EV_WITHDRAW: Symbol = symbol_short!("withdraw");

#[contractclient(name = "VerifierClient")]
pub trait VerifierTrait {
    /// External audited verifier — accepts (proof, public inputs); panics on bad proof.
    fn verify(env: Env, proof: Bytes, public_inputs: Vec<BytesN<32>>) -> bool;
}

#[contract]
pub struct PrivacyPool;

#[contractimpl]
impl PrivacyPool {
    pub fn init(env: Env, admin: Address, usdc_sac: Address, verifier: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::UsdcSac, &usdc_sac);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
    }

    /// Admin curates the allowlist (ASP membership).
    pub fn approve_address(env: Env, who: Address) {
        Self::require_admin(&env);
        env.storage().persistent().set(&DataKey::Allow(who), &true);
    }

    pub fn deny_address(env: Env, who: Address) {
        Self::require_admin(&env);
        env.storage().persistent().set(&DataKey::Deny(who), &true);
    }

    /// deposit — buyer transfers USDC into the pool and registers a commitment.
    pub fn deposit(env: Env, buyer: Address, amount_stroops: i128, commitment: BytesN<32>) {
        buyer.require_auth();
        Self::assert_member(&env, &buyer);
        if amount_stroops <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if amount_stroops > MAX_DEPOSIT_STROOPS {
            panic_with_error!(&env, Error::DepositTooLarge);
        }
        let key = DataKey::Commitment(commitment.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::DuplicateCommitment);
        }
        let usdc: Address = env.storage().instance().get(&DataKey::UsdcSac).unwrap();
        token::Client::new(&env, &usdc).transfer(
            &buyer,
            &env.current_contract_address(),
            &amount_stroops,
        );
        env.storage().persistent().set(&key, &amount_stroops);
        env.events().publish((EV_DEPOSIT, buyer), (commitment, amount_stroops));
    }

    /// private_transfer — emits an opaque event; amount + counterparty hidden.
    /// `public_inputs` ordering (matches Nethermind reference):
    ///   [0] = new commitment, [1] = nullifier_in, [2] = merkle_root snapshot.
    pub fn private_transfer(env: Env, proof: Bytes, public_inputs: Vec<BytesN<32>>) {
        if public_inputs.len() < 3 {
            panic_with_error!(&env, Error::InvalidProof);
        }
        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        let ok = VerifierClient::new(&env, &verifier).verify(&proof, &public_inputs);
        if !ok {
            panic_with_error!(&env, Error::InvalidProof);
        }
        let new_commitment = public_inputs.get_unchecked(0);
        let nullifier_in = public_inputs.get_unchecked(1);
        let null_key = DataKey::Nullifier(nullifier_in.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, Error::NullifierSpent);
        }
        env.storage().persistent().set(&null_key, &true);
        // Carry-forward note value is opaque to the chain — we record only the
        // new commitment with sentinel value 0; real value lives in the ZK note.
        env.storage().persistent().set(&DataKey::Commitment(new_commitment.clone()), &0i128);
        env.events().publish((EV_TRANSFER, new_commitment), nullifier_in);
    }

    /// withdraw — agent / recipient burns a nullifier and pulls USDC out.
    /// `public_inputs` ordering: [0] = nullifier, [1] = recipient_addr_hash,
    /// [2] = amount_stroops_be32 (right-padded). The verifier confirms the
    /// withdrawal proof matches.
    pub fn withdraw(
        env: Env,
        recipient: Address,
        amount_stroops: i128,
        nullifier: BytesN<32>,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) {
        recipient.require_auth();
        Self::assert_member(&env, &recipient);
        if amount_stroops <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        if !VerifierClient::new(&env, &verifier).verify(&proof, &public_inputs) {
            panic_with_error!(&env, Error::InvalidProof);
        }
        let null_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, Error::NullifierSpent);
        }
        env.storage().persistent().set(&null_key, &true);
        let usdc: Address = env.storage().instance().get(&DataKey::UsdcSac).unwrap();
        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount_stroops,
        );
        env.events().publish((EV_WITHDRAW, recipient), (nullifier, amount_stroops));
    }

    pub fn is_allowlisted(env: Env, who: Address) -> bool {
        env.storage().persistent().get(&DataKey::Allow(who)).unwrap_or(false)
    }

    pub fn is_denylisted(env: Env, who: Address) -> bool {
        env.storage().persistent().get(&DataKey::Deny(who)).unwrap_or(false)
    }

    // ── internals ────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        admin.require_auth();
    }

    fn assert_member(env: &Env, who: &Address) {
        if env.storage().persistent().get::<DataKey, bool>(&DataKey::Deny(who.clone())).unwrap_or(false) {
            panic_with_error!(env, Error::Denylisted);
        }
        if !env.storage().persistent().get::<DataKey, bool>(&DataKey::Allow(who.clone())).unwrap_or(false) {
            panic_with_error!(env, Error::NotAllowlisted);
        }
    }
}

#[cfg(test)]
mod test;
