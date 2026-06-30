//! paid-call-ledger — accrues per-agent revenue + supports payouts/refunds.
//!
//! The chain side of OpenX-S settlement. Mirror table in Supabase is
//! `paid_calls`; that DB is the analytics + UX surface, this contract is
//! the trust anchor.
//!
//! SOLID:
//! - SRP: only the `paywall-router` may *write* (accrue / refund). Only the
//!   agent's seller may withdraw their own balance. Two roles, two paths.
//! - DIP: paywall-router holds *our* address and invokes `accrue` directly;
//!   we don't read state from the router (loose coupling).

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error, symbol_short, token,
    Address, BytesN, Env, Symbol,
};

#[contracttype]
pub enum DataKey {
    Admin,
    Router,                      // authorised writer (paywall-router contract)
    UsdcSac,                     // Stellar Asset Contract id for USDC
    Balance(BytesN<32>),         // agent_id -> i128 stroops
    Refund(BytesN<32>),          // call_id  -> i128 stroops (pending refund)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InsufficientBalance = 4,
    InvalidAmount = 5,
    NoPendingRefund = 6,
}

const EV_ACCRUE: Symbol = symbol_short!("accrue");
const EV_PAYOUT: Symbol = symbol_short!("payout");
const EV_REFUND: Symbol = symbol_short!("refund");

#[contract]
pub struct PaidCallLedger;

#[contractimpl]
impl PaidCallLedger {
    pub fn init(env: Env, admin: Address, router: Address, usdc_sac: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Router, &router);
        env.storage().instance().set(&DataKey::UsdcSac, &usdc_sac);
    }

    /// Router calls this after a successful `hire_agent` to record revenue.
    /// `amount_stroops` is the seller share already split by the router.
    pub fn accrue(env: Env, agent_id: BytesN<32>, amount_stroops: i128) {
        let router: Address = env
            .storage()
            .instance()
            .get(&DataKey::Router)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        router.require_auth();
        if amount_stroops <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let key = DataKey::Balance(agent_id.clone());
        let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(prev + amount_stroops));
        env.events().publish((EV_ACCRUE, agent_id), amount_stroops);
    }

    pub fn get_agent_balance(env: Env, agent_id: BytesN<32>) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(agent_id)).unwrap_or(0)
    }

    /// Seller withdraws accrued balance to their own address. The seller must
    /// auth — we never custody on their behalf beyond what the router already
    /// transferred in.
    pub fn agent_payout(env: Env, seller: Address, agent_id: BytesN<32>, amount_stroops: i128) {
        seller.require_auth();
        if amount_stroops <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let key = DataKey::Balance(agent_id.clone());
        let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if prev < amount_stroops {
            panic_with_error!(&env, Error::InsufficientBalance);
        }
        env.storage().persistent().set(&key, &(prev - amount_stroops));
        let usdc: Address = env.storage().instance().get(&DataKey::UsdcSac).unwrap();
        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &seller,
            &amount_stroops,
        );
        env.events().publish((EV_PAYOUT, agent_id), amount_stroops);
    }

    /// Admin-only dispute → mark a pending refund the buyer can claim.
    pub fn mark_refund(env: Env, call_id: BytesN<32>, buyer: Address, amount_stroops: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if amount_stroops <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        env.storage().persistent().set(&DataKey::Refund(call_id.clone()), &amount_stroops);
        env.events().publish((EV_REFUND, buyer), call_id);
    }

    /// Buyer claims an admin-marked refund.
    pub fn buyer_refund(env: Env, buyer: Address, call_id: BytesN<32>) {
        buyer.require_auth();
        let key = DataKey::Refund(call_id.clone());
        let amount: i128 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingRefund));
        env.storage().persistent().remove(&key);
        let usdc: Address = env.storage().instance().get(&DataKey::UsdcSac).unwrap();
        token::Client::new(&env, &usdc).transfer(
            &env.current_contract_address(),
            &buyer,
            &amount,
        );
        env.events().publish((EV_REFUND, buyer), call_id);
    }
}

#[cfg(test)]
mod test;
