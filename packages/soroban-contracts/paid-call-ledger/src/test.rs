#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, IntoVal,
};

struct Fixture<'a> {
    env: Env,
    client: PaidCallLedgerClient<'a>,
    admin: Address,
    router: Address,
    usdc_sac: Address,
    usdc_admin: StellarAssetClient<'a>,
    ledger_addr: Address,
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let usdc_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let usdc_sac = usdc_contract.address();
    let usdc_admin = StellarAssetClient::new(&env, &usdc_sac);

    let ledger_addr = env.register_contract(None, PaidCallLedger);
    let client = PaidCallLedgerClient::new(&env, &ledger_addr);
    client.init(&admin, &router, &usdc_sac);

    Fixture {
        env,
        client,
        admin,
        router,
        usdc_sac,
        usdc_admin,
        ledger_addr,
    }
}

#[test]
fn accrue_and_payout_round_trip() {
    let f = setup();
    let seller = Address::generate(&f.env);
    let agent_id = BytesN::from_array(&f.env, &[1u8; 32]);

    // The router previously credited the contract with 1.50 USDC. Mint to
    // ledger contract so balance is real.
    f.usdc_admin.mint(&f.ledger_addr, &15_000_000i128);
    f.client.accrue(&agent_id, &15_000_000i128);
    assert_eq!(f.client.get_agent_balance(&agent_id), 15_000_000i128);

    f.client.agent_payout(&seller, &agent_id, &15_000_000i128);
    assert_eq!(f.client.get_agent_balance(&agent_id), 0);
    let token = TokenClient::new(&f.env, &f.usdc_sac);
    assert_eq!(token.balance(&seller), 15_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn payout_overdraft_rejected() {
    let f = setup();
    let seller = Address::generate(&f.env);
    let agent_id = BytesN::from_array(&f.env, &[1u8; 32]);
    f.client.accrue(&agent_id, &1_000_000i128);
    f.client.agent_payout(&seller, &agent_id, &2_000_000i128);
}

#[test]
fn refund_round_trip() {
    let f = setup();
    let buyer = Address::generate(&f.env);
    let call_id = BytesN::from_array(&f.env, &[9u8; 32]);
    f.usdc_admin.mint(&f.ledger_addr, &5_000_000i128);
    f.client.mark_refund(&call_id, &buyer, &5_000_000i128);
    f.client.buyer_refund(&buyer, &call_id);
    let token = TokenClient::new(&f.env, &f.usdc_sac);
    assert_eq!(token.balance(&buyer), 5_000_000i128);
}
