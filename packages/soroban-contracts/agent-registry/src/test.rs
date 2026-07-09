#![cfg(test)]

use super::*;
use soroban_sdk::{symbol_short, testutils::Address as _, BytesN, Env, String};

fn setup() -> (Env, AgentRegistryClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register_contract(None, AgentRegistry);
    let client = AgentRegistryClient::new(&env, &contract_id);
    client.init(&admin);
    (env, client, admin)
}

#[test]
fn register_then_get() {
    let (env, client, _) = setup();
    let seller = Address::generate(&env);
    let agent_id = client.register_agent(
        &seller,
        &String::from_str(&env, "translator-en-vi"),
        &String::from_str(&env, "EN→VI Legal Translator"),
        &15_000_000i128, // 1.50 USDC
        &BytesN::from_array(&env, &[1u8; 32]),
        &false,
    );
    let m = client.get_agent(&agent_id);
    assert_eq!(m.price_stroops, 15_000_000);
    assert_eq!(m.slug, String::from_str(&env, "translator-en-vi"));
    assert_eq!(m.seller, seller);
}

#[test]
fn update_pricing_by_seller() {
    let (env, client, _) = setup();
    let seller = Address::generate(&env);
    let agent_id = client.register_agent(
        &seller,
        &String::from_str(&env, "agent-x"),
        &String::from_str(&env, "Agent X"),
        &10_000_000i128,
        &BytesN::from_array(&env, &[2u8; 32]),
        &false,
    );
    client.update_pricing(&agent_id, &25_000_000i128);
    let m = client.get_agent(&agent_id);
    assert_eq!(m.price_stroops, 25_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn negative_price_rejected() {
    let (env, client, _) = setup();
    let seller = Address::generate(&env);
    client.register_agent(
        &seller,
        &String::from_str(&env, "bad"),
        &String::from_str(&env, "Bad"),
        &-1i128,
        &BytesN::from_array(&env, &[0u8; 32]),
        &false,
    );
}

#[test]
fn certify_then_get() {
    let (env, client, _) = setup();
    let seller = Address::generate(&env);
    let agent_id = client.register_agent(
        &seller,
        &String::from_str(&env, "certme"),
        &String::from_str(&env, "Cert Me"),
        &10_000_000i128,
        &BytesN::from_array(&env, &[7u8; 32]),
        &false,
    );
    assert!(client.get_certification(&agent_id).is_none());

    let cert = client.certify_agent(
        &agent_id,
        &8500u32,
        &BytesN::from_array(&env, &[9u8; 32]),
        &1u32,
    );
    assert_eq!(cert.score_bps, 8500);
    assert_eq!(cert.status, symbol_short!("certified"));

    let fetched = client.get_certification(&agent_id).unwrap();
    assert_eq!(fetched.score_bps, 8500);
    assert!(fetched.expires_at > fetched.certified_at);
}

#[test]
fn revoke_downgrades_to_legacy() {
    let (env, client, _) = setup();
    let seller = Address::generate(&env);
    let agent_id = client.register_agent(
        &seller,
        &String::from_str(&env, "legacyme"),
        &String::from_str(&env, "Legacy Me"),
        &10_000_000i128,
        &BytesN::from_array(&env, &[3u8; 32]),
        &false,
    );
    client.certify_agent(&agent_id, &9000u32, &BytesN::from_array(&env, &[1u8; 32]), &1u32);
    client.revoke_certification(&agent_id, &true);
    assert_eq!(client.get_certification(&agent_id).unwrap().status, symbol_short!("legacy"));
    client.revoke_certification(&agent_id, &false);
    assert_eq!(client.get_certification(&agent_id).unwrap().status, symbol_short!("revoked"));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn score_over_max_rejected() {
    let (env, client, _) = setup();
    let seller = Address::generate(&env);
    let agent_id = client.register_agent(
        &seller,
        &String::from_str(&env, "overscore"),
        &String::from_str(&env, "Over"),
        &10_000_000i128,
        &BytesN::from_array(&env, &[5u8; 32]),
        &false,
    );
    client.certify_agent(&agent_id, &10_001u32, &BytesN::from_array(&env, &[0u8; 32]), &1u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn revoke_uncertified_rejected() {
    let (env, client, _) = setup();
    let seller = Address::generate(&env);
    let agent_id = client.register_agent(
        &seller,
        &String::from_str(&env, "nocert"),
        &String::from_str(&env, "No Cert"),
        &10_000_000i128,
        &BytesN::from_array(&env, &[6u8; 32]),
        &false,
    );
    client.revoke_certification(&agent_id, &true);
}

#[test]
fn list_paginates() {
    let (env, client, _) = setup();
    for i in 0u8..5u8 {
        let seller = Address::generate(&env);
        client.register_agent(
            &seller,
            &String::from_str(&env, "agent"),
            &String::from_str(&env, "Agent"),
            &(1_000_000i128 * (i as i128 + 1)),
            &BytesN::from_array(&env, &[i; 32]),
            &false,
        );
    }
    let page = client.list_agents(&0, &3);
    assert_eq!(page.len(), 3);
    let page2 = client.list_agents(&3, &10);
    assert_eq!(page2.len(), 2);
}
