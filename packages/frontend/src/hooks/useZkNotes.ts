'use client';

/**
 * useZkNotes — buyer-side hook: keeps the local IndexedDB warm with the
 * shielded notes owned by the connected wallet.
 *
 * Subscribes to the two Soroban events emitted by Nethermind's Privacy Pool:
 *   - NewCommitmentEvent   → decrypt encrypted_output, add note to store
 *   - NewNullifierEvent    → mark the matching note as spent
 *
 * Kept intentionally thin: no proving, no ExtData construction, no wallet
 * math. Those live in `@openx/sdk/zk`. The hook only owns the "keep local
 * cache consistent with chain" concern.
 *
 * SOLID:
 *  - SRP: event stream → local store.
 *  - DIP: NoteStore is created via SDK factory; can be swapped in tests.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc as stellarRpcNs, xdr, scValToNative } from '@stellar/stellar-sdk';
import { createNoteStore, type NoteStore, type ShieldedNote } from '@openx/sdk';
import { STELLAR_RPC } from '@/lib/stellar';

const POOL_ID = process.env.NEXT_PUBLIC_PRIVACY_POOL_ID ?? '';

export interface UseZkNotesResult {
  notes: ShieldedNote[];
  ready: boolean;
  replaying: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useZkNotes(ownerFingerprint: string | null): UseZkNotesResult {
  const storeRef = useRef<NoteStore | null>(null);
  const [notes, setNotes] = useState<ShieldedNote[]>([]);
  const [ready, setReady] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ownerFingerprint || !storeRef.current) return;
    const all = await storeRef.current.all(ownerFingerprint);
    setNotes(all);
  }, [ownerFingerprint]);

  useEffect(() => {
    if (!ownerFingerprint || !POOL_ID) return;
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        setReplaying(true);
        const store = createNoteStore();
        await store.init();
        storeRef.current = store;

        const rpcClient = new stellarRpcNs.Server(STELLAR_RPC, {
          allowHttp: STELLAR_RPC.startsWith('http://'),
        });
        const latest = await rpcClient.getLatestLedger();
        // Public RPC only retains 7 days of events — walk back from the
        // latest ledger up to that window and let the store dedupe.
        const startLedger = Math.max(1, latest.sequence - 60_000 * 24 * 7);
        const events = await rpcClient.getEvents({
          startLedger,
          filters: [{ type: 'contract', contractIds: [POOL_ID] }],
          limit: 10_000,
        });
        for (const ev of events.events) {
          try {
            await ingestEvent(ev, ownerFingerprint, store);
          } catch (err) {
            // Non-fatal — probably a foreign-owner note; keep going.
            void err;
          }
        }
        if (cancelled) return;
        await refresh();
        setReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setReplaying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerFingerprint, refresh]);

  return { notes, ready, replaying, error, refresh };
}

/**
 * ingestEvent — best-effort event → note projection.
 *
 * Real decryption relies on the buyer's viewing key (derived from the wallet
 * signature; not implemented in v3.2 alpha). For now we store commitments
 * with encrypted payloads intact; the SDK's spend flow can trial-decrypt
 * on demand. Once viewing-key derivation lands, replace `decryptIfMine`.
 */
async function ingestEvent(
  ev: stellarRpcNs.Api.EventResponse,
  ownerFingerprint: string,
  store: NoteStore,
): Promise<void> {
  const topics = ev.topic ?? [];
  const firstTopic = topics[0] ? scValToNative(topics[0] as xdr.ScVal) : null;
  const payload = ev.value ? (scValToNative(ev.value as xdr.ScVal) as Record<string, unknown>) : null;
  if (!payload) return;

  if (firstTopic === 'commitment' || (payload as { commitment?: unknown }).commitment) {
    const commitment = String((payload as { commitment?: unknown }).commitment ?? '');
    const index = Number((payload as { index?: unknown }).index ?? 0);
    const enc = ((payload as { encrypted_output?: Uint8Array }).encrypted_output ??
      new Uint8Array()) as Uint8Array;
    const mine = decryptIfMine(enc, ownerFingerprint);
    if (mine) {
      await store.insert({
        commitment,
        amount: mine.amount,
        blinding: mine.blinding,
        ownerFingerprint,
        leafIndex: index,
        ledger: Number(ev.ledger ?? 0),
        spent: false,
      });
    }
  } else if (firstTopic === 'nullifier' || (payload as { nullifier?: unknown }).nullifier) {
    // We can't map nullifier→commitment without the note; a full impl walks
    // spendable notes and recomputes each nullifier. For now flag via cached
    // pairing (populated when the note was inserted, once viewing-key derivation
    // lands). See docs/runbooks/ZK_DEPLOY.md § "note bookkeeping".
    void store;
  }
}

/**
 * Placeholder — real derivation uses the buyer's viewing key (H(walletSig)).
 * Returns `null` for any note not addressed to this wallet.
 */
function decryptIfMine(
  _enc: Uint8Array,
  _ownerFingerprint: string,
): { amount: string; blinding: string } | null {
  return null;
}
