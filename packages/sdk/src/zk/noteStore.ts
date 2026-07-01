/**
 * @openx/sdk/zk/noteStore — IndexedDB-backed UTXO cache for the private tier.
 *
 * Kept minimal on purpose: one object store keyed by commitment; enough to
 * answer "which notes can this wallet spend?" and "has this nullifier been
 * consumed?". Consumers layer their own decryption/derivation on top.
 *
 * SOLID:
 *  - SRP: pure storage. No wallet math, no proof, no HTTP.
 *  - LSP: the exported interface is a `NoteStore`; the IndexedDB variant is
 *    the browser impl. Tests can inject an in-memory implementation.
 */

const DB_NAME = 'openx-zk-notes';
const STORE = 'notes';
const DB_VERSION = 1;

export interface ShieldedNote {
  /** 32-byte big-endian commitment (hex). Primary key. */
  commitment: string;
  /** UTXO value in the pool's asset base units (bigint serialised as string). */
  amount: string;
  /** Blinding scalar (hex, 32 bytes). */
  blinding: string;
  /** Owner viewing-key fingerprint (hex, keeps notes wallet-scoped). */
  ownerFingerprint: string;
  /** Merkle-tree leaf index when the commitment was inserted. */
  leafIndex: number;
  /** Ledger sequence the commitment landed at (helps replay/GC). */
  ledger: number;
  /** True once a nullifier has been observed on-chain. */
  spent: boolean;
}

export interface NoteStore {
  init(): Promise<void>;
  insert(note: ShieldedNote): Promise<void>;
  getSpendable(ownerFingerprint: string, minAmount: bigint): Promise<ShieldedNote[]>;
  markSpent(commitment: string): Promise<void>;
  all(ownerFingerprint: string): Promise<ShieldedNote[]>;
}

class IndexedDbNoteStore implements NoteStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  async init(): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('noteStore: IndexedDB not available (server-side render?)');
    }
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const os = db.createObjectStore(STORE, { keyPath: 'commitment' });
            os.createIndex('byOwner', 'ownerFingerprint', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    await this.dbPromise;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    if (!this.dbPromise) await this.init();
    const db = await this.dbPromise!;
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async insert(note: ShieldedNote): Promise<void> {
    const os = await this.tx('readwrite');
    await promisify(os.put(note));
  }

  async markSpent(commitment: string): Promise<void> {
    const os = await this.tx('readwrite');
    const existing = (await promisify(os.get(commitment))) as ShieldedNote | undefined;
    if (!existing) return;
    existing.spent = true;
    await promisify(os.put(existing));
  }

  async getSpendable(ownerFingerprint: string, minAmount: bigint): Promise<ShieldedNote[]> {
    const notes = await this.all(ownerFingerprint);
    return notes.filter((n) => !n.spent && BigInt(n.amount) >= minAmount);
  }

  async all(ownerFingerprint: string): Promise<ShieldedNote[]> {
    const os = await this.tx('readonly');
    const idx = os.index('byOwner');
    const req = idx.getAll(ownerFingerprint);
    return promisify<ShieldedNote[]>(req);
  }
}

/** In-memory fallback for tests / SSR contexts. */
class InMemoryNoteStore implements NoteStore {
  private notes = new Map<string, ShieldedNote>();
  async init(): Promise<void> {}
  async insert(n: ShieldedNote): Promise<void> {
    this.notes.set(n.commitment, n);
  }
  async markSpent(c: string): Promise<void> {
    const n = this.notes.get(c);
    if (n) n.spent = true;
  }
  async getSpendable(fp: string, min: bigint): Promise<ShieldedNote[]> {
    return [...this.notes.values()].filter(
      (n) => n.ownerFingerprint === fp && !n.spent && BigInt(n.amount) >= min,
    );
  }
  async all(fp: string): Promise<ShieldedNote[]> {
    return [...this.notes.values()].filter((n) => n.ownerFingerprint === fp);
  }
}

/**
 * Returns the appropriate NoteStore for the current runtime — IndexedDB in
 * the browser, in-memory everywhere else.
 */
export function createNoteStore(): NoteStore {
  return typeof indexedDB === 'undefined' ? new InMemoryNoteStore() : new IndexedDbNoteStore();
}

function promisify<T = unknown>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
