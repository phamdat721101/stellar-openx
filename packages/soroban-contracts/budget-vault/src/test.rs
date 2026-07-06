#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, String,
};

struct Fixture {
    env: Env,
    vault: BudgetVaultClient<'static>,
    asset_sac: Address,
    _asset_admin: StellarAssetClient<'static>,
    buyer: Address,
    _platform: Address,
    seller: Address,
    treasury: Address,
}

/// Every Vec / String / Address must be constructed from the SAME `Env` as
/// the contract itself — Soroban tags host-object references by env
/// identity. So callers pass an `env`-scoped builder that gets the
/// allowlist ready before we register the contract.
fn setup_with<F>(builder: F) -> Fixture
where
    F: FnOnce(&Env) -> (AllowlistMode, Vec<String>, Vec<Address>),
{
    let env = Env::default();
    env.mock_all_auths();
    let buyer = Address::generate(&env);
    let platform = Address::generate(&env);
    let seller = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let asset_contract = env.register_stellar_asset_contract_v2(token_admin);
    let asset_sac = asset_contract.address();
    let asset_admin = StellarAssetClient::new(&env, &asset_sac);
    asset_admin.mint(&buyer, &1_000_000_000i128); // 100 units @ 7 decimals

    let (mode, slugs, sellers) = builder(&env);

    let vault_addr = env.register_contract(None, BudgetVault);
    let vault = BudgetVaultClient::new(&env, &vault_addr);

    vault.init(&VaultConfig {
        buyer: buyer.clone(),
        platform: platform.clone(),
        asset: asset_sac.clone(),
        treasury: treasury.clone(),
        total_cap: 500_000_000i128,     // 50 units
        per_hire_cap: 50_000_000i128,   // 5 units
        platform_bp: 500,
        mode,
        allowlist_slugs: slugs,
        allowlist_sellers: sellers,
        created_at: 0,
    });

    Fixture { env, vault, asset_sac, _asset_admin: asset_admin, buyer, _platform: platform, seller, treasury }
}

fn setup_any() -> Fixture {
    setup_with(|env| (AllowlistMode::Any, vec![env], vec![env]))
}

// ── Happy paths ────────────────────────────────────────────────────────────

#[test]
fn deposit_updates_balance() {
    let f = setup_any();
    f.vault.deposit(&100_000_000i128); // 10 units
    assert_eq!(f.vault.balance(), 100_000_000i128);
    assert_eq!(f.vault.total_spent(), 0i128);
    assert_eq!(f.vault.hire_count(), 0u64);
}

#[test]
fn debit_splits_95_5_and_updates_counters() {
    let f = setup_any();
    f.vault.deposit(&100_000_000i128); // 10.0 units
    let receipt = f.vault.debit_for_hire(
        &f.seller,
        &String::from_str(&f.env, "translator"),
        &30_000_000i128, // 3.0 units — under 5 per_hire_cap
    );
    assert_eq!(receipt.amount_gross, 30_000_000);
    assert_eq!(receipt.amount_to_seller, 28_500_000);   // 95%
    assert_eq!(receipt.amount_to_platform, 1_500_000);  // 5%
    assert_eq!(receipt.hire_count, 1);

    let token = TokenClient::new(&f.env, &f.asset_sac);
    assert_eq!(token.balance(&f.seller), 28_500_000);
    assert_eq!(token.balance(&f.treasury), 1_500_000);
    assert_eq!(f.vault.balance(), 70_000_000);
    assert_eq!(f.vault.total_spent(), 30_000_000);
    assert_eq!(f.vault.hire_count(), 1);
}

#[test]
fn withdraw_partial_and_full() {
    let f = setup_any();
    f.vault.deposit(&100_000_000i128);
    f.vault.withdraw(&20_000_000i128);
    assert_eq!(f.vault.balance(), 80_000_000);
    // amount=0 means "withdraw all"
    f.vault.withdraw(&0i128);
    assert_eq!(f.vault.balance(), 0);
}

#[test]
fn slugs_mode_allows_listed_agent_only() {
    let f = setup_with(|env| (
        AllowlistMode::Slugs,
        vec![env, String::from_str(env, "translator")],
        vec![env],
    ));
    f.vault.deposit(&100_000_000i128);
    f.vault.debit_for_hire(
        &f.seller,
        &String::from_str(&f.env, "translator"),
        &10_000_000i128,
    );
    assert_eq!(f.vault.hire_count(), 1);
}

// ── Reversions ─────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn init_twice_reverts() {
    let f = setup_any();
    let cfg = f.vault.get_config();
    f.vault.init(&cfg);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn deposit_zero_reverts() {
    let f = setup_any();
    f.vault.deposit(&0i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn per_hire_cap_reverts() {
    let f = setup_any();
    f.vault.deposit(&100_000_000i128);
    f.vault.debit_for_hire(
        &f.seller,
        &String::from_str(&f.env, "any"),
        &60_000_000i128, // 6.0 > 5.0 per-hire cap
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn insufficient_funds_reverts() {
    let f = setup_any();
    f.vault.deposit(&10_000_000i128); // 1.0 unit
    f.vault.debit_for_hire(
        &f.seller,
        &String::from_str(&f.env, "any"),
        &20_000_000i128, // 2.0 units — vault only holds 1
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn slugs_mode_rejects_unlisted_agent() {
    let f = setup_with(|env| (
        AllowlistMode::Slugs,
        vec![env, String::from_str(env, "translator")],
        vec![env],
    ));
    f.vault.deposit(&100_000_000i128);
    f.vault.debit_for_hire(
        &f.seller,
        &String::from_str(&f.env, "not-listed"),
        &10_000_000i128,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn sellers_mode_rejects_unlisted_seller() {
    let f = setup_with(|env| {
        let allowed = Address::generate(env);
        (AllowlistMode::Sellers, vec![env], vec![env, allowed])
    });
    // Fresh seller that isn't in the (env-scoped) allowlist.
    let bad_seller = Address::generate(&f.env);
    f.vault.deposit(&100_000_000i128);
    f.vault.debit_for_hire(&bad_seller, &String::from_str(&f.env, "any"), &10_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn paused_vault_rejects_hires() {
    let f = setup_any();
    f.vault.deposit(&100_000_000i128);
    f.vault.set_status(&1u32); // paused
    f.vault.debit_for_hire(&f.seller, &String::from_str(&f.env, "any"), &10_000_000i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn closed_vault_rejects_deposits() {
    let f = setup_any();
    f.vault.set_status(&2u32); // closed
    f.vault.deposit(&10_000_000i128);
}

#[test]
fn closed_vault_still_allows_withdraw() {
    let f = setup_any();
    f.vault.deposit(&50_000_000i128);
    f.vault.set_status(&2u32);
    f.vault.withdraw(&0i128); // drain a closed vault is permitted
    assert_eq!(f.vault.balance(), 0);
}

#[test]
fn set_allowlist_updates_atomically() {
    let f = setup_any();
    let env_ref = &f.env;
    let slugs = vec![env_ref, String::from_str(env_ref, "translator")];
    let empty_sellers: Vec<Address> = vec![env_ref];
    f.vault.set_allowlist(&AllowlistMode::Slugs, &slugs, &empty_sellers);
    let cfg = f.vault.get_config();
    assert!(matches!(cfg.mode, AllowlistMode::Slugs));
    assert_eq!(cfg.allowlist_slugs.len(), 1);
    assert_eq!(cfg.allowlist_sellers.len(), 0);
}
