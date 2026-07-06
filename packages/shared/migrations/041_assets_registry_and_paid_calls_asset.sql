-- 041_assets_registry_and_paid_calls_asset.sql — PRD-M v0.30 (MGUSD × x402 v2).
--
-- Purpose:
--   1. `supported_assets` table  — table-driven SEP-41 asset registry so the
--      paywall + payment gate + escrow can settle in any registered stablecoin
--      (USDC today, MGUSD from Jun 2 2026, OUSD/EURC future).
--   2. `paid_calls.asset_code`  — records which asset was actually settled.
--
-- Additive migration only. No destructive schema changes. Rollback = drop
-- table + drop column (both `IF EXISTS`).
--
-- SOLID (SRP): this file owns the asset-registration schema. On-chain SAC
-- deploys stay in Soroban land (agent-registry/paywall-router); this table
-- is the source of truth for "which stablecoins can settle a paid_call".

CREATE TABLE IF NOT EXISTS supported_assets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL,                                  -- 'USDC' | 'MGUSD' | 'TMGUSD' …
  network          TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  sac_contract     TEXT NOT NULL,                                  -- SEP-41 Stellar Asset Contract (C…)
  issuer_gaddress  TEXT,                                           -- classic-asset issuer G-address (nullable — pure-Soroban tokens have none)
  precision        INT NOT NULL DEFAULT 7,                         -- SEP-41 decimals (USDC + MGUSD both use 7)
  min_amount       NUMERIC(20,7) NOT NULL DEFAULT 0.001,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,             -- {display_name, icon_url, ramps[], minter_gateway, retail_locations, countries}
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (code, network),
  UNIQUE (sac_contract)
);

CREATE INDEX IF NOT EXISTS supported_assets_network_idx  ON supported_assets (network);
CREATE INDEX IF NOT EXISTS supported_assets_enabled_idx  ON supported_assets (enabled) WHERE enabled = TRUE;

-- Day-1 seed. Verified against Circle + M0 canonical docs (docs.m0.org/resources/addresses/mgusd-platform).
-- Idempotent: re-running the migration is a no-op after first apply.
INSERT INTO supported_assets (code, network, sac_contract, issuer_gaddress, precision, metadata) VALUES
  ('USDC',   'testnet',
   'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
   'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
   7,
   '{"display_name":"USD Coin (Testnet)","icon_url":"/icons/usdc.svg","ramps":["circle-cctp","moneygram-anchor"]}'),
  ('USDC',   'mainnet',
   'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
   'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
   7,
   '{"display_name":"USD Coin","icon_url":"/icons/usdc.svg","ramps":["circle-cctp","moneygram-anchor"]}'),
  ('TMGUSD', 'testnet',
   'CCWJCHDLXEIMXODO5JFZLRUM7AMA7EI2NBRBL44ROCL6WH44W22NM7HM',
   NULL,
   7,
   '{"display_name":"MoneyGram USD (Testnet)","icon_url":"/icons/mgusd.svg","ramps":["moneygram-anchor-sep24"],"minter_gateway":"CCPGOJYZAJ4H5JW2WFN2C5O4SC6DBJB7QD4ACQ2A3GUMKFMYNXLMYJME"}'),
  ('MGUSD',  'mainnet',
   'CDK2LDSYUKPEFN3HNE7K7ETUT3VIOBHSOXAK5CTO4A4RKKZQUCAIWCJA',
   NULL,
   7,
   '{"display_name":"MoneyGram USD","icon_url":"/icons/mgusd.svg","ramps":["moneygram-anchor-sep24","moneygram-retail-cashout"],"minter_gateway":"CD7LJGITEYTOAVKH3PPAVOBWXLMMFGK3NN5W4QAXFJLNSNS4R46TW562","retail_locations":500000,"countries":200}')
ON CONFLICT (code, network) DO NOTHING;

-- paid_calls.asset_code — record which asset actually settled the hire.
-- Backfill defaults to 'USDC' (every pre-v0.30 row was USDC-only).
ALTER TABLE paid_calls ADD COLUMN IF NOT EXISTS asset_code TEXT NOT NULL DEFAULT 'USDC';

CREATE INDEX IF NOT EXISTS paid_calls_asset_idx ON paid_calls (asset_code, created_at DESC);
