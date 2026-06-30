#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, Vec,
};

// Two stub verifiers, each in its own module so `#[contractimpl]` doesn't
// emit duplicate `__verify` symbols in the parent module.

mod accept_verifier {
    use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Vec};

    #[contract]
    pub struct AcceptVerifier;

    #[contractimpl]
    impl AcceptVerifier {
        pub fn verify(_env: Env, _proof: Bytes, _public_inputs: Vec<BytesN<32>>) -> bool {
            true
        }
    }
}

mod reject_verifier {
    use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Vec};

    #[contract]
    pub struct RejectVerifier;

    #[contractimpl]
    impl RejectVerifier {
        pub fn verify(_env: Env, _proof: Bytes, _public_inputs: Vec<BytesN<32>>) -> bool {
            false
        }
    }
}

use accept_verifier::AcceptVerifier;
use reject_verifier::RejectVerifier;

struct Fixture {
    env: Env,
    pool: PrivacyPoolClient<'static>,
    usdc: Address,
    usdc_admin: StellarAssetClient<'static>,
    buyer: Address,
    pool_addr: Address,
}

fn setup(accept: bool) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let usdc_contract = env.register_stellar_asset_contract_v2(token_admin);
    let usdc = usdc_contract.address();
    let usdc_admin = StellarAssetClient::new(&env, &usdc);
    usdc_admin.mint(&buyer, &500_000_000i128);

    let verifier_addr = if accept {
        env.register_contract(None, AcceptVerifier)
    } else {
        env.register_contract(None, RejectVerifier)
    };

    let pool_addr = env.register_contract(None, PrivacyPool);
    let pool = PrivacyPoolClient::new(&env, &pool_addr);
    pool.init(&admin, &usdc, &verifier_addr);
    pool.approve_address(&buyer);

    Fixture { env, pool, usdc, usdc_admin, buyer, pool_addr }
}

#[test]
fn deposit_increases_pool_balance() {
    let f = setup(true);
    let commitment = BytesN::from_array(&f.env, &[1u8; 32]);
    f.pool.deposit(&f.buyer, &50_000_000i128, &commitment);
    let token = TokenClient::new(&f.env, &f.usdc);
    assert_eq!(token.balance(&f.pool_addr), 50_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn deposit_over_cap_rejected() {
    let f = setup(true);
    let commitment = BytesN::from_array(&f.env, &[2u8; 32]);
    f.pool.deposit(&f.buyer, &200_000_000i128, &commitment);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn duplicate_commitment_rejected() {
    let f = setup(true);
    let commitment = BytesN::from_array(&f.env, &[3u8; 32]);
    f.pool.deposit(&f.buyer, &10_000_000i128, &commitment);
    f.pool.deposit(&f.buyer, &10_000_000i128, &commitment);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn non_allowlisted_deposit_rejected() {
    let f = setup(true);
    let stranger = Address::generate(&f.env);
    f.usdc_admin.mint(&stranger, &10_000_000i128);
    let commitment = BytesN::from_array(&f.env, &[4u8; 32]);
    f.pool.deposit(&stranger, &10_000_000i128, &commitment);
}

#[test]
fn private_transfer_then_withdraw() {
    let f = setup(true);
    let c0 = BytesN::from_array(&f.env, &[10u8; 32]);
    f.pool.deposit(&f.buyer, &50_000_000i128, &c0);

    let proof = Bytes::from_array(&f.env, &[0xAB; 8]);
    let mut inputs: Vec<BytesN<32>> = Vec::new(&f.env);
    inputs.push_back(BytesN::from_array(&f.env, &[11u8; 32]));
    inputs.push_back(BytesN::from_array(&f.env, &[12u8; 32]));
    inputs.push_back(BytesN::from_array(&f.env, &[13u8; 32]));
    f.pool.private_transfer(&proof, &inputs);

    let recipient = Address::generate(&f.env);
    f.pool.approve_address(&recipient);
    let null_out = BytesN::from_array(&f.env, &[14u8; 32]);
    let mut wi: Vec<BytesN<32>> = Vec::new(&f.env);
    wi.push_back(null_out.clone());
    wi.push_back(BytesN::from_array(&f.env, &[15u8; 32]));
    wi.push_back(BytesN::from_array(&f.env, &[16u8; 32]));
    f.pool.withdraw(&recipient, &50_000_000i128, &null_out, &proof, &wi);
    let token = TokenClient::new(&f.env, &f.usdc);
    assert_eq!(token.balance(&recipient), 50_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn bad_proof_rejected() {
    let f = setup(false);
    let mut inputs: Vec<BytesN<32>> = Vec::new(&f.env);
    inputs.push_back(BytesN::from_array(&f.env, &[1u8; 32]));
    inputs.push_back(BytesN::from_array(&f.env, &[2u8; 32]));
    inputs.push_back(BytesN::from_array(&f.env, &[3u8; 32]));
    f.pool.private_transfer(&Bytes::from_array(&f.env, &[0u8; 4]), &inputs);
}
