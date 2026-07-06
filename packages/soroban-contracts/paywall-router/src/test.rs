#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String,
};

use agent_registry::{AgentRegistry, AgentRegistryClient};
use paid_call_ledger::{PaidCallLedger, PaidCallLedgerClient};

struct Fixture {
    env: Env,
    router: PaywallRouterClient<'static>,
    registry: AgentRegistryClient<'static>,
    ledger: PaidCallLedgerClient<'static>,
    treasury: Address,
    usdc_sac: Address,
    /// v0.30 — auxiliary SAC for testing multi-asset settlement (stands in
    /// for MGUSD in-test; asset-agnostic per SEP-41).
    mgusd_sac: Address,
    buyer: Address,
    seller: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // USDC SAC + MGUSD SAC (two independent stellar-asset-contracts). Both
    // implement the SEP-41 token trait; the paywall-router treats them
    // identically because it just holds an `Address` and calls
    // `token::Client::new(sac).transfer(...)`.
    let usdc_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let usdc_sac = usdc_contract.address();
    let usdc_admin = StellarAssetClient::new(&env, &usdc_sac);
    usdc_admin.mint(&buyer, &100_000_000i128); // 10 USDC

    let mgusd_contract = env.register_stellar_asset_contract_v2(token_admin);
    let mgusd_sac = mgusd_contract.address();
    let mgusd_admin = StellarAssetClient::new(&env, &mgusd_sac);
    mgusd_admin.mint(&buyer, &100_000_000i128); // 10 MGUSD

    let registry_addr = env.register_contract(None, AgentRegistry);
    let ledger_addr = env.register_contract(None, PaidCallLedger);
    let router_addr = env.register_contract(None, PaywallRouter);

    let registry = AgentRegistryClient::new(&env, &registry_addr);
    let ledger = PaidCallLedgerClient::new(&env, &ledger_addr);
    let router = PaywallRouterClient::new(&env, &router_addr);

    registry.init(&admin);
    ledger.init(&admin, &router_addr, &usdc_sac);
    router.init(&admin, &registry_addr, &ledger_addr, &usdc_sac, &treasury, &500u32);

    Fixture { env, router, registry, ledger, treasury, usdc_sac, mgusd_sac, buyer, seller }
}

fn seed_agent(f: &Fixture, price_stroops: i128) -> BytesN<32> {
    f.registry.register_agent(
        &f.seller,
        &String::from_str(&f.env, "translator"),
        &String::from_str(&f.env, "Translator"),
        &price_stroops,
        &BytesN::from_array(&f.env, &[7u8; 32]),
        &false,
    )
}

/// Backward compat: legacy callers pass `asset=None` — settles in the
/// stored default (USDC). Identical semantics to pre-v0.30.
#[test]
fn public_hire_default_asset_splits_95_5() {
    let f = setup();
    let agent_id = seed_agent(&f, 15_000_000); // 1.50 USDC

    let call_id = f.router.hire_agent(
        &f.buyer,
        &agent_id,
        &BytesN::from_array(&f.env, &[1u8; 32]),
        &PaymentMode::Public,
        &None,
    );

    let token = TokenClient::new(&f.env, &f.usdc_sac);
    assert_eq!(token.balance(&f.treasury), 750_000i128);         // 5%
    assert_eq!(f.ledger.get_agent_balance(&agent_id), 14_250_000i128); // 95%

    let rec = f.router.get_call(&call_id);
    assert!(!rec.completed);
    assert_eq!(rec.gross_stroops, 15_000_000i128);
}

/// v0.30 multi-asset settlement — caller passes `asset=Some(mgusd_sac)`,
/// split lands in the MGUSD SAC. USDC SAC untouched.
#[test]
fn public_hire_mgusd_asset_splits_95_5() {
    let f = setup();
    let agent_id = seed_agent(&f, 10_000_000); // 1.00 MGUSD

    f.router.hire_agent(
        &f.buyer,
        &agent_id,
        &BytesN::from_array(&f.env, &[9u8; 32]),
        &PaymentMode::Public,
        &Some(f.mgusd_sac.clone()),
    );

    let mgusd = TokenClient::new(&f.env, &f.mgusd_sac);
    let usdc  = TokenClient::new(&f.env, &f.usdc_sac);
    assert_eq!(mgusd.balance(&f.treasury), 500_000i128);   // 5% of 1.00 MGUSD
    assert_eq!(usdc.balance(&f.treasury), 0i128);         // ← untouched
    // ledger accrues seller share regardless of asset — it tracks stroops.
    assert_eq!(f.ledger.get_agent_balance(&agent_id), 9_500_000i128); // 95%
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn private_mode_reverts() {
    let f = setup();
    let agent_id = seed_agent(&f, 1_000_000);
    f.router.hire_agent(
        &f.buyer,
        &agent_id,
        &BytesN::from_array(&f.env, &[2u8; 32]),
        &PaymentMode::Private,
        &None,
    );
}

#[test]
fn complete_then_dispute() {
    let f = setup();
    let agent_id = seed_agent(&f, 10_000_000);
    let call_id = f.router.hire_agent(
        &f.buyer,
        &agent_id,
        &BytesN::from_array(&f.env, &[4u8; 32]),
        &PaymentMode::Public,
        &None,
    );
    f.router.record_call_completion(
        &f.seller,
        &call_id,
        &BytesN::from_array(&f.env, &[5u8; 32]),
        &1234u64,
    );
    f.router.dispute_call(&f.buyer, &call_id, &BytesN::from_array(&f.env, &[6u8; 32]));
    let rec = f.router.get_call(&call_id);
    assert!(rec.completed);
    assert!(rec.disputed);
}
