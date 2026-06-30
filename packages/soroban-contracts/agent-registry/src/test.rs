#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, BytesN, Env, String};

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
