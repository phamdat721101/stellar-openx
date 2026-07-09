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

/// PRD-T-S — on-chain certification record for the training pipeline.
/// Written by the platform registrar once an agent clears the S4 eval gate.
/// `status` is one of the `symbol_short!` labels: certified | legacy | revoked.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Certification {
    pub agent_id: BytesN<32>,
    pub score_bps: u32,       // mean eval score in basis points (0-10000)
    pub cert_hash: BytesN<32>,
    pub version: u32,
    pub certified_at: u64,
    pub expires_at: u64,
    pub status: Symbol,
}

#[contracttype]
pub enum DataKey {
    Agent(BytesN<32>),
    Index(u32),
    Count,
    Admin,
    Cert(BytesN<32>),
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
    InvalidScore = 6,
    NotCertified = 7,
}

const EV_REG: Symbol = symbol_short!("reg");
const EV_PRICE: Symbol = symbol_short!("price");
const EV_CERT: Symbol = symbol_short!("cert");

/// Certification validity window — 90 days, matched to the off-chain
/// `agent_certifications.expires_at` default and the quarterly re-cert cron.
const CERT_TTL_SECS: u64 = 90 * 86_400;

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
        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        // Deterministic 32-byte id: 4 bytes count || 28 zero pad.
        //
        // We DO NOT mix `ledger().timestamp()` into the id any more —
        // Soroban tx footprints are declared during simulation, but
        // `ts` at exec-time differs from sim-time, so the derived
        // storage key `Agent(agent_id)` falls outside the footprint and
        // the host traps with "data key outside of the footprint".
        // `count` is monotonic per-contract-instance, so collisions are
        // impossible. The original creation timestamp lives in the
        // `created_at` metadata field for audit.
        let mut bytes = [0u8; 32];
        bytes[..4].copy_from_slice(&count.to_be_bytes());
        let agent_id: BytesN<32> = BytesN::from_array(&env, &bytes);

        let ts = env.ledger().timestamp();

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

    // ── PRD-T-S certification (platform-registrar authored) ──────────────────

    /// Award/renew an on-chain certification for `agent_id`. Only the admin
    /// (platform registrar) may call — the platform relayer is the tx source,
    /// so `admin.require_auth()` is satisfied by the source-account shortcut.
    /// Re-running bumps `version` semantics off-chain; on-chain it overwrites.
    pub fn certify_agent(
        env: Env,
        agent_id: BytesN<32>,
        score_bps: u32,
        cert_hash: BytesN<32>,
        version: u32,
    ) -> Certification {
        Self::admin(&env).require_auth();
        if score_bps > 10_000 {
            panic_with_error!(&env, Error::InvalidScore);
        }
        // Certification presupposes the agent exists.
        if !env.storage().persistent().has(&DataKey::Agent(agent_id.clone())) {
            panic_with_error!(&env, Error::NotFound);
        }
        let now = env.ledger().timestamp();
        let cert = Certification {
            agent_id: agent_id.clone(),
            score_bps,
            cert_hash,
            version,
            certified_at: now,
            expires_at: now + CERT_TTL_SECS,
            status: symbol_short!("certified"),
        };
        env.storage().persistent().set(&DataKey::Cert(agent_id.clone()), &cert);
        env.events().publish((EV_CERT, agent_id), score_bps);
        cert
    }

    /// Downgrade a certification. `to_legacy=true` keeps earning enabled with a
    /// disclosure banner (quarterly re-cert failure); `false` fully revokes.
    pub fn revoke_certification(env: Env, agent_id: BytesN<32>, to_legacy: bool) {
        Self::admin(&env).require_auth();
        let mut cert: Certification = env
            .storage()
            .persistent()
            .get(&DataKey::Cert(agent_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotCertified));
        cert.status = if to_legacy {
            symbol_short!("legacy")
        } else {
            symbol_short!("revoked")
        };
        env.storage().persistent().set(&DataKey::Cert(agent_id.clone()), &cert);
        env.events().publish((EV_CERT, agent_id), cert.status.clone());
    }

    pub fn get_certification(env: Env, agent_id: BytesN<32>) -> Option<Certification> {
        env.storage().persistent().get(&DataKey::Cert(agent_id))
    }

    fn admin(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
}

#[cfg(test)]
mod test;
