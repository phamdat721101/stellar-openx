//! paywall-router — buyer-side x402 entry point.
//!
//! Receives `hire_agent(buyer, agent_id, query_hash, mode)`. In `Public`
//! mode it pulls USDC from the buyer (via SAC), splits 95% to the seller
//! payout address (registered in agent-registry) and 5% to the platform
//! treasury, then accrues into paid-call-ledger. In `Private` mode it
//! reverts with `UsePrivacyPool` — buyers in that tier route through the
//! `privacy-pool` contract directly so amount + counterparty stay hidden.

#![no_std]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, contracterror, panic_with_error,
    symbol_short, token, Address, BytesN, Env, Symbol,
};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PaymentMode {
    Public = 0,
    Private = 1,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Registry,
    Ledger,
    UsdcSac,
    Treasury,
    PlatformBp,
    Call(BytesN<32>),
    CallCount,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CallRecord {
    pub buyer: Address,
    pub agent_id: BytesN<32>,
    pub query_hash: BytesN<32>,
    pub gross_stroops: i128,
    pub completed: bool,
    pub disputed: bool,
    pub created_at: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    AgentNotFound = 4,
    UsePrivacyPool = 5,
    CallNotFound = 6,
    AlreadyCompleted = 7,
    InvalidBasisPoints = 8,
}

const EV_HIRE: Symbol = symbol_short!("hire");
const EV_DONE: Symbol = symbol_short!("done");
const EV_DISP: Symbol = symbol_short!("disp");

#[contractclient(name = "RegistryClient")]
pub trait RegistryTrait {
    fn get_agent(env: Env, agent_id: BytesN<32>) -> AgentLite;
}

#[contractclient(name = "LedgerClient")]
pub trait LedgerTrait {
    fn accrue(env: Env, agent_id: BytesN<32>, amount_stroops: i128);
}

#[contracttype]
#[derive(Clone)]
pub struct AgentLite {
    pub schema_version: u32,
    pub slug: soroban_sdk::String,
    pub seller: Address,
    pub price_stroops: i128,
    pub display_name: soroban_sdk::String,
    pub manifest_hash: BytesN<32>,
    pub kya_required: bool,
    pub created_at: u64,
}

#[contract]
pub struct PaywallRouter;

#[contractimpl]
impl PaywallRouter {
    pub fn init(
        env: Env,
        admin: Address,
        registry: Address,
        ledger: Address,
        usdc_sac: Address,
        treasury: Address,
        platform_bp: u32,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        if platform_bp > 10_000 {
            panic_with_error!(&env, Error::InvalidBasisPoints);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&DataKey::Ledger, &ledger);
        env.storage().instance().set(&DataKey::UsdcSac, &usdc_sac);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::PlatformBp, &platform_bp);
    }

    pub fn hire_agent(
        env: Env,
        buyer: Address,
        agent_id: BytesN<32>,
        query_hash: BytesN<32>,
        mode: PaymentMode,
        asset: Option<Address>,
    ) -> BytesN<32> {
        buyer.require_auth();
        if matches!(mode, PaymentMode::Private) {
            panic_with_error!(&env, Error::UsePrivacyPool);
        }
        let registry: Address = env.storage().instance().get(&DataKey::Registry).unwrap();
        let agent: AgentLite = RegistryClient::new(&env, &registry).get_agent(&agent_id);

        let ledger: Address = env.storage().instance().get(&DataKey::Ledger).unwrap();
        // Asset resolution: caller-supplied SAC (any SEP-41) OR the stored
        // default (USDC). Preserves byte-identical behaviour for every
        // pre-v0.30 caller — they pass `None` and get the historical USDC
        // rail. v0.30+ callers pass `Some(mgusd_sac)` to settle in MGUSD.
        let sac: Address = asset.unwrap_or_else(|| {
            env.storage().instance().get(&DataKey::UsdcSac).unwrap()
        });
        let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        let bp: u32 = env.storage().instance().get(&DataKey::PlatformBp).unwrap();

        let gross = agent.price_stroops;
        let platform = (gross * bp as i128) / 10_000;
        let seller_share = gross - platform;

        // Any SEP-41 SAC exposes the same `token` interface — no branch needed.
        let token_client = token::Client::new(&env, &sac);
        token_client.transfer(&buyer, &ledger, &seller_share);
        if platform > 0 {
            token_client.transfer(&buyer, &treasury, &platform);
        }
        LedgerClient::new(&env, &ledger).accrue(&agent_id, &seller_share);

        // Deterministic 32-byte call id: 4 bytes count || 28 bytes query_hash.
        //
        // Excluding `ledger().timestamp()` is required for the same
        // footprint reason as agent-registry: sim-time ts ≠ exec-time ts
        // would derive a different `Call(call_id)` key and trap.
        // `count` is monotonic; `query_hash` is buyer-provided and
        // deterministic, so the call id still correlates the on-chain
        // record with the buyer's off-chain query.
        let ts = env.ledger().timestamp();
        let count: u32 = env.storage().instance().get(&DataKey::CallCount).unwrap_or(0);
        let qh = query_hash.to_array();
        let mut bytes = [0u8; 32];
        bytes[..4].copy_from_slice(&count.to_be_bytes());
        bytes[4..].copy_from_slice(&qh[..28]);
        let call_id: BytesN<32> = BytesN::from_array(&env, &bytes);
        env.storage().instance().set(&DataKey::CallCount, &(count + 1));

        env.storage().persistent().set(
            &DataKey::Call(call_id.clone()),
            &CallRecord {
                buyer: buyer.clone(),
                agent_id: agent_id.clone(),
                query_hash,
                gross_stroops: gross,
                completed: false,
                disputed: false,
                created_at: ts,
            },
        );

        env.events().publish((EV_HIRE, buyer), (agent_id, call_id.clone()));
        call_id
    }

    pub fn record_call_completion(
        env: Env,
        agent_seller: Address,
        call_id: BytesN<32>,
        output_hash: BytesN<32>,
        duration_ms: u64,
    ) {
        agent_seller.require_auth();
        let mut rec: CallRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Call(call_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::CallNotFound));
        if rec.completed {
            panic_with_error!(&env, Error::AlreadyCompleted);
        }
        rec.completed = true;
        env.storage().persistent().set(&DataKey::Call(call_id.clone()), &rec);
        env.events().publish((EV_DONE, call_id), (output_hash, duration_ms));
    }

    pub fn dispute_call(env: Env, buyer: Address, call_id: BytesN<32>, reason: BytesN<32>) {
        buyer.require_auth();
        let mut rec: CallRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Call(call_id.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::CallNotFound));
        if rec.buyer != buyer {
            panic_with_error!(&env, Error::Unauthorized);
        }
        rec.disputed = true;
        env.storage().persistent().set(&DataKey::Call(call_id.clone()), &rec);
        env.events().publish((EV_DISP, buyer), (call_id, reason));
    }

    pub fn get_call(env: Env, call_id: BytesN<32>) -> CallRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Call(call_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::CallNotFound))
    }
}

#[cfg(test)]
mod test;
