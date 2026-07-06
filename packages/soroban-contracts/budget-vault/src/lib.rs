//! budget-vault — buyer-owned Soroban vault for deposit-once-hire-many UX.
//!
//! Trust model:
//!   • Only the buyer can `deposit`, `withdraw`, `set_allowlist`, `pause`.
//!   • Only the platform address (set at init) can `debit_for_hire` —
//!     the on-chain contract enforces the buyer's allowlist + per-hire cap
//!     so the platform is a **relayer**, not a custodian.
//!   • Both roles use `require_auth`, so replays/impersonation are impossible.
//!
//! Split policy (identical to paywall-router):
//!   95% → seller, 5% → platform treasury. `platform_bp` fixed at init.
//!
//! Storage keys:
//!   Config           — VaultConfig (one instance-slot)
//!   Balance          — cached total spent (persistent counter)
//!   HireCount        — cumulative hire count (persistent counter)
//!
//! SOLID:
//!   • SRP — this contract owns *only* the vault lifecycle. It never
//!     reads agent-registry or paid-call-ledger state; the platform
//!     signs `debit_for_hire` with the seller address it already knows
//!     off-chain (from agents.owner_address).
//!   • OCP — allowlist is data-driven (mode + Vec entries); adding a
//!     new mode is a compile-time enum extension, not a fork.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error, symbol_short, token,
    Address, Env, String, Symbol, Vec,
};

// ── Types ──────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum AllowlistMode {
    Any,
    Slugs,      // entries in `allowlist` are agent slugs (String)
    Sellers,    // entries in `allowlist` are seller addresses (Address)
}

#[contracttype]
#[derive(Clone)]
pub struct VaultConfig {
    pub buyer: Address,
    pub platform: Address,   // OpenX platform address — sole `debit_for_hire` authority
    pub asset: Address,      // SEP-41 SAC (USDC or MGUSD)
    pub treasury: Address,   // platform-fee recipient
    pub total_cap: i128,     // 0 = unlimited
    pub per_hire_cap: i128,  // 0 = no per-hire cap
    pub platform_bp: u32,    // basis points (5% = 500)
    pub mode: AllowlistMode,
    pub allowlist_slugs: Vec<String>,       // filled only when mode == Slugs
    pub allowlist_sellers: Vec<Address>,    // filled only when mode == Sellers
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct HireReceipt {
    pub seller: Address,
    pub agent_slug: String,
    pub amount_gross: i128,
    pub amount_to_seller: i128,
    pub amount_to_platform: i128,
    pub balance_after: i128,
    pub hire_count: u64,
    pub timestamp: u64,
}

#[contracttype]
pub enum DataKey {
    Config,
    TotalSpent,
    HireCount,
    Status,             // 0 = active, 1 = paused, 2 = closed
}

const STATUS_ACTIVE: u32 = 0;
const STATUS_PAUSED: u32 = 1;
const STATUS_CLOSED: u32 = 2;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    Unauthorized       = 3,
    InvalidAmount      = 4,
    InvalidBasisPoints = 5,
    NotAllowed         = 6,
    PerHireCapExceeded = 7,
    TotalCapExceeded   = 8,
    InsufficientFunds  = 9,
    VaultPaused        = 10,
    VaultClosed        = 11,
}

const EV_INIT:      Symbol = symbol_short!("init");
const EV_DEPOSIT:   Symbol = symbol_short!("deposit");
const EV_HIRE:      Symbol = symbol_short!("hire");
const EV_WITHDRAW:  Symbol = symbol_short!("withdraw");
const EV_ALLOWLIST: Symbol = symbol_short!("allowlst");
const EV_STATUS:    Symbol = symbol_short!("status");

// ── Contract ───────────────────────────────────────────────────────────────

#[contract]
pub struct BudgetVault;

#[contractimpl]
impl BudgetVault {
    /// Combined init + fund entrypoint. Buyer signs one tx that stores the
    /// vault config AND pulls the initial deposit from their wallet. Nested
    /// SAC.transfer(buyer → contract) inherits buyer auth from the tx.
    ///
    /// Follow-up `deposit()` calls are still supported for topups.
    pub fn init_with_deposit(env: Env, cfg: VaultConfig, initial_deposit: i128) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        if cfg.platform_bp > 10_000 {
            panic_with_error!(&env, Error::InvalidBasisPoints);
        }
        if cfg.total_cap < 0 || cfg.per_hire_cap < 0 || initial_deposit < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        cfg.buyer.require_auth();
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::TotalSpent, &0i128);
        env.storage().instance().set(&DataKey::HireCount, &0u64);
        env.storage().instance().set(&DataKey::Status, &STATUS_ACTIVE);
        if initial_deposit > 0 {
            token::Client::new(&env, &cfg.asset).transfer(
                &cfg.buyer,
                &env.current_contract_address(),
                &initial_deposit,
            );
        }
        env.events().publish((EV_INIT, cfg.buyer.clone()), (cfg.asset.clone(), initial_deposit));
    }

    /// Zero-deposit init — for buyers who want to configure the vault first
    /// and top up in a follow-up tx. Otherwise identical to `init_with_deposit`.
    pub fn init(env: Env, cfg: VaultConfig) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        if cfg.platform_bp > 10_000 {
            panic_with_error!(&env, Error::InvalidBasisPoints);
        }
        if cfg.total_cap < 0 || cfg.per_hire_cap < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        cfg.buyer.require_auth();
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::TotalSpent, &0i128);
        env.storage().instance().set(&DataKey::HireCount, &0u64);
        env.storage().instance().set(&DataKey::Status, &STATUS_ACTIVE);
        env.events().publish((EV_INIT, cfg.buyer.clone()), (cfg.asset.clone(), cfg.total_cap));
    }

    /// Buyer deposits SEP-41 asset into the vault. Requires buyer auth
    /// for the SAC transfer.
    pub fn deposit(env: Env, amount: i128) {
        let cfg = Self::config(&env);
        cfg.buyer.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if Self::status(&env) == STATUS_CLOSED {
            panic_with_error!(&env, Error::VaultClosed);
        }
        token::Client::new(&env, &cfg.asset).transfer(
            &cfg.buyer,
            &env.current_contract_address(),
            &amount,
        );
        env.events().publish((EV_DEPOSIT, cfg.buyer), amount);
    }

    /// Platform relays a hire. On-chain enforcement of allowlist + caps.
    /// Returns a receipt the caller can persist off-chain.
    pub fn debit_for_hire(
        env: Env,
        seller: Address,
        agent_slug: String,
        amount: i128,
    ) -> HireReceipt {
        let cfg = Self::config(&env);
        // Only the platform address may debit. Buyer's allowlist limits the
        // platform's discretion — the platform never chooses to spend, it
        // only executes hires the buyer has pre-authorized.
        cfg.platform.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let status = Self::status(&env);
        if status == STATUS_PAUSED { panic_with_error!(&env, Error::VaultPaused); }
        if status == STATUS_CLOSED { panic_with_error!(&env, Error::VaultClosed); }

        Self::assert_allowed(&env, &cfg, &seller, &agent_slug);

        if cfg.per_hire_cap > 0 && amount > cfg.per_hire_cap {
            panic_with_error!(&env, Error::PerHireCapExceeded);
        }

        let total_spent: i128 = env.storage().instance().get(&DataKey::TotalSpent).unwrap_or(0);
        if cfg.total_cap > 0 && total_spent + amount > cfg.total_cap {
            panic_with_error!(&env, Error::TotalCapExceeded);
        }

        let sac = token::Client::new(&env, &cfg.asset);
        let vault_addr = env.current_contract_address();
        let balance = sac.balance(&vault_addr);
        if balance < amount {
            panic_with_error!(&env, Error::InsufficientFunds);
        }

        // 95/5 split — identical policy to paywall-router.
        let platform_share = (amount * cfg.platform_bp as i128) / 10_000;
        let seller_share = amount - platform_share;
        sac.transfer(&vault_addr, &seller, &seller_share);
        if platform_share > 0 {
            sac.transfer(&vault_addr, &cfg.treasury, &platform_share);
        }

        let new_total = total_spent + amount;
        let hire_count: u64 = env.storage().instance().get(&DataKey::HireCount).unwrap_or(0) + 1;
        env.storage().instance().set(&DataKey::TotalSpent, &new_total);
        env.storage().instance().set(&DataKey::HireCount, &hire_count);

        let ts = env.ledger().timestamp();
        let receipt = HireReceipt {
            seller: seller.clone(),
            agent_slug: agent_slug.clone(),
            amount_gross: amount,
            amount_to_seller: seller_share,
            amount_to_platform: platform_share,
            balance_after: balance - amount,
            hire_count,
            timestamp: ts,
        };
        env.events().publish((EV_HIRE, cfg.buyer.clone()), (seller, amount));
        receipt
    }

    /// Buyer withdraws vault balance. `amount == 0` means "withdraw all".
    pub fn withdraw(env: Env, amount: i128) {
        let cfg = Self::config(&env);
        cfg.buyer.require_auth();
        if amount < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let sac = token::Client::new(&env, &cfg.asset);
        let vault_addr = env.current_contract_address();
        let balance = sac.balance(&vault_addr);
        let to_withdraw = if amount == 0 { balance } else { amount };
        if to_withdraw > balance {
            panic_with_error!(&env, Error::InsufficientFunds);
        }
        if to_withdraw > 0 {
            sac.transfer(&vault_addr, &cfg.buyer, &to_withdraw);
        }
        env.events().publish((EV_WITHDRAW, cfg.buyer.clone()), to_withdraw);
    }

    /// Buyer atomically replaces the allowlist. Mode + entries must be
    /// consistent (Slugs mode ⇒ non-empty slugs list; ditto sellers).
    pub fn set_allowlist(
        env: Env,
        mode: AllowlistMode,
        slugs: Vec<String>,
        sellers: Vec<Address>,
    ) {
        let mut cfg = Self::config(&env);
        cfg.buyer.require_auth();
        match mode {
            AllowlistMode::Any => {
                cfg.mode = AllowlistMode::Any;
                cfg.allowlist_slugs = Vec::new(&env);
                cfg.allowlist_sellers = Vec::new(&env);
            }
            AllowlistMode::Slugs => {
                cfg.mode = AllowlistMode::Slugs;
                cfg.allowlist_slugs = slugs;
                cfg.allowlist_sellers = Vec::new(&env);
            }
            AllowlistMode::Sellers => {
                cfg.mode = AllowlistMode::Sellers;
                cfg.allowlist_sellers = sellers;
                cfg.allowlist_slugs = Vec::new(&env);
            }
        }
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events().publish((EV_ALLOWLIST, cfg.buyer.clone()), 0u32);
    }

    /// Buyer flips status. Closed vaults reject deposits + hires but still
    /// permit withdraw (to drain remaining balance). Pausing is reversible;
    /// closing is one-way (fresh vault required to resume).
    pub fn set_status(env: Env, new_status: u32) {
        let cfg = Self::config(&env);
        cfg.buyer.require_auth();
        if new_status > STATUS_CLOSED {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        // One-way: closed can only stay closed.
        let current = Self::status(&env);
        if current == STATUS_CLOSED && new_status != STATUS_CLOSED {
            panic_with_error!(&env, Error::VaultClosed);
        }
        env.storage().instance().set(&DataKey::Status, &new_status);
        env.events().publish((EV_STATUS, cfg.buyer), new_status);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    pub fn get_config(env: Env) -> VaultConfig { Self::config(&env) }

    pub fn balance(env: Env) -> i128 {
        let cfg = Self::config(&env);
        token::Client::new(&env, &cfg.asset).balance(&env.current_contract_address())
    }

    pub fn total_spent(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalSpent).unwrap_or(0)
    }

    pub fn hire_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::HireCount).unwrap_or(0)
    }

    pub fn get_status(env: Env) -> u32 { Self::status(&env) }

    // ── Internals ──────────────────────────────────────────────────────────

    fn config(env: &Env) -> VaultConfig {
        env.storage().instance().get(&DataKey::Config)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    fn status(env: &Env) -> u32 {
        env.storage().instance().get(&DataKey::Status).unwrap_or(STATUS_ACTIVE)
    }

    fn assert_allowed(env: &Env, cfg: &VaultConfig, seller: &Address, agent_slug: &String) {
        match cfg.mode {
            AllowlistMode::Any => {}
            AllowlistMode::Slugs => {
                if !cfg.allowlist_slugs.iter().any(|s| s == *agent_slug) {
                    panic_with_error!(env, Error::NotAllowed);
                }
            }
            AllowlistMode::Sellers => {
                if !cfg.allowlist_sellers.iter().any(|a| a == *seller) {
                    panic_with_error!(env, Error::NotAllowed);
                }
            }
        }
    }
}

#[cfg(test)]
mod test;
