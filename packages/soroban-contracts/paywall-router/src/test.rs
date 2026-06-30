#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String,
};

// Reuse the production agent-registry + paid-call-ledger crates as
// in-test dependencies via env.register. They're sibling crates in the
// workspace; we link them dev-only by declaring them in the test entry.
use agent_registry::{AgentRegistry, AgentRegistryClient};
use paid_call_ledger::{PaidCallLedger, PaidCallLedgerClient};

struct Fixture {
    env: Env,
    router: PaywallRouterClient<'static>,
    registry: AgentRegistryClient<'static>,
    ledger: PaidCallLedgerClient<'static>,
    treasury: Address,
    usdc_sac: Address,
    usdc_admin: StellarAssetClient<'static>,
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

    // USDC SAC (Stellar Asset Contract)
    let usdc_contract = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_sac = usdc_contract.address();
    let usdc_admin = StellarAssetClient::new(&env, &usdc_sac);
    usdc_admin.mint(&buyer, &100_000_000i128); // 10 USDC

    let registry_addr = env.register_contract(None, AgentRegistry);
    let ledger_addr = env.register_contract(None, PaidCallLedger);
    let router_addr = env.register_contract(None, PaywallRouter);

    let registry = AgentRegistryClient::new(&env, &registry_addr);
    let ledger = PaidCallLedgerClient::new(&env, &ledger_addr);
    let router = PaywallRouterClient::new(&env, &router_addr);

    registry.init(&admin);
    ledger.init(&admin, &router_addr, &usdc_sac);
    router.init(&admin, &registry_addr, &ledger_addr, &usdc_sac, &treasury, &500u32);

    Fixture { env, router, registry, ledger, treasury, usdc_sac, usdc_admin, buyer, seller }
}

#[test]
fn public_hire_splits_95_5() {
    let f = setup();
    let agent_id = f.registry.register_agent(
        &f.seller,
        &String::from_str(&f.env, "translator"),
        &String::from_str(&f.env, "Translator"),
        &15_000_000i128, // 1.50 USDC
        &BytesN::from_array(&f.env, &[7u8; 32]),
        &false,
    );

    let call_id = f.router.hire_agent(
        &f.buyer,
        &agent_id,
        &BytesN::from_array(&f.env, &[1u8; 32]),
        &PaymentMode::Public,
    );

    let token = TokenClient::new(&f.env, &f.usdc_sac);
    // Treasury got 5% (750 000 stroops).
    assert_eq!(token.balance(&f.treasury), 750_000i128);
    // Ledger holds the 95% (14 250 000) until payout.
    assert_eq!(f.ledger.get_agent_balance(&agent_id), 14_250_000i128);

    let rec = f.router.get_call(&call_id);
    assert!(!rec.completed);
    assert_eq!(rec.gross_stroops, 15_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn private_mode_reverts() {
    let f = setup();
    let agent_id = f.registry.register_agent(
        &f.seller,
        &String::from_str(&f.env, "x"),
        &String::from_str(&f.env, "X"),
        &1_000_000i128,
        &BytesN::from_array(&f.env, &[0u8; 32]),
        &false,
    );
    f.router.hire_agent(
        &f.buyer,
        &agent_id,
        &BytesN::from_array(&f.env, &[2u8; 32]),
        &PaymentMode::Private,
    );
}

#[test]
fn complete_then_dispute() {
    let f = setup();
    let agent_id = f.registry.register_agent(
        &f.seller,
        &String::from_str(&f.env, "y"),
        &String::from_str(&f.env, "Y"),
        &10_000_000i128,
        &BytesN::from_array(&f.env, &[3u8; 32]),
        &false,
    );
    let call_id = f.router.hire_agent(
        &f.buyer,
        &agent_id,
        &BytesN::from_array(&f.env, &[4u8; 32]),
        &PaymentMode::Public,
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
