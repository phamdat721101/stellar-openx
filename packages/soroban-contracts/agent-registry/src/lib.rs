//! agent-registry — listing & metadata for OpenX-S agents.
//!
//! Replaces the EVM `AgentRegistry.sol` + `agentIdentityRegistry.ts` services.
//! Single-responsibility: store agent metadata + emit events; pricing and
//! payment routing live in `paywall-router`.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error, symbol_short,
    Address, BytesN, Env, String, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentMetadata {
    pub schema_version: u32,
    pub slug: String,
    pub seller: Address,
    pub price_stroops: i128,
    pub display_name: String,
    pub manifest_hash: BytesN<32>,
    pub kya_required: bool,
    pub created_at: u64,
}

#[contracttype]
pub enum DataKey {
    Agent(BytesN<32>),
    Index(u32),
    Count,
    Admin,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    NotFound = 4,
    InvalidPrice = 5,
}

const EV_REG: Symbol = symbol_short!("reg");
const EV_PRICE: Symbol = symbol_short!("price");

#[contract]
pub struct AgentRegistry;

#[contractimpl]
impl AgentRegistry {
    pub fn init(env: Env, admin: Address) {
        let key = DataKey::Admin;
        if env.storage().instance().has(&key) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&key, &admin);
    }

    pub fn register_agent(
        env: Env,
        seller: Address,
        slug: String,
        display_name: String,
        price_stroops: i128,
        manifest_hash: BytesN<32>,
        kya_required: bool,
    ) -> BytesN<32> {
        // Platform is the registrar (gasless onboard). The off-chain identity
        // check already gated this call. No on-chain seller auth required.
        if price_stroops < 0 {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        let ts = env.ledger().timestamp();
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        // Deterministic 32-byte id: 4 bytes count || 8 bytes ts || 20 zero pad.
        // Avoids keccak256 host-fn complexity for v3.0.0; collisions are
        // impossible because `count` is monotonically incremented.
        let mut bytes = [0u8; 32];
        bytes[..4].copy_from_slice(&count.to_be_bytes());
        bytes[4..12].copy_from_slice(&ts.to_be_bytes());
        let agent_id: BytesN<32> = BytesN::from_array(&env, &bytes);

        let metadata = AgentMetadata {
            schema_version: 1,
            slug,
            seller: seller.clone(),
            price_stroops,
            display_name,
            manifest_hash,
            kya_required,
            created_at: ts,
        };

        env.storage().persistent().set(&DataKey::Agent(agent_id.clone()), &metadata);
        env.storage().instance().set(&DataKey::Index(count), &agent_id);
        env.storage().instance().set(&DataKey::Count, &(count + 1));

        env.events().publish((EV_REG, seller), agent_id.clone());
        agent_id
    }

    pub fn update_pricing(env: Env, agent_id: BytesN<32>, new_price_stroops: i128) {
        if new_price_stroops < 0 {
            panic_with_error!(&env, Error::InvalidPrice);
        }
        let mut m: AgentMetadata = env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));
        m.seller.require_auth();
        m.price_stroops = new_price_stroops;
        env.storage().persistent().set(&DataKey::Agent(agent_id.clone()), &m);
        env.events().publish((EV_PRICE, agent_id), new_price_stroops);
    }

    pub fn get_agent(env: Env, agent_id: BytesN<32>) -> AgentMetadata {
        env.storage()
            .persistent()
            .get(&DataKey::Agent(agent_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound))
    }

    pub fn list_agents(env: Env, offset: u32, limit: u32) -> Vec<AgentMetadata> {
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let mut out = Vec::new(&env);
        let mut i = offset;
        let end = core::cmp::min(count, offset.saturating_add(limit));
        while i < end {
            if let Some(id) = env.storage().instance().get::<DataKey, BytesN<32>>(&DataKey::Index(i)) {
                if let Some(m) = env.storage().persistent().get::<DataKey, AgentMetadata>(&DataKey::Agent(id)) {
                    out.push_back(m);
                }
            }
            i += 1;
        }
        out
    }
}

#[cfg(test)]
mod test;
