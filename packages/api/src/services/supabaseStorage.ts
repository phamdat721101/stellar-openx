/**
 * supabaseStorage.ts — encrypted-blob hosting for OpenX brains.
 *
 * Replaces the Walrus + Tatum pipeline. Stores AES-256-GCM ciphertext
 * (encryption happens client-side; the server never sees plaintext) in a
 * Supabase Storage bucket. Returns a self-describing URI of the form
 * `supabase://<bucket>/<path>` that callers persist in `brains.payload_uri`.
 *
 * SOLID:
 *   • SRP   — blob upload / download / signed-URL only. No knowledge of
 *             brains, encryption, or auth.
 *   • DIP   — `SupabaseClient` is constructor-injected; tests pass a stub.
 *   • OCP   — adding presigned-write or multipart simply adds a method.
 *
 * Env (read by `getSupabaseStorage()` only — direct construction is keyless):
 *   SUPABASE_URL                 https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    server-only key with bucket-write scope
 *   SUPABASE_STORAGE_BUCKET      defaults to 'brain-blobs'
 */

import type { Logger } from 'pino';

/**
 * Structural type for the bits of `SupabaseClient` we use. This lets the
 * service compile before `@supabase/supabase-js` is installed; the runtime
 * `require()` call below pulls the real client at first use.
 */
interface SupabaseClientLike {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Buffer | Uint8Array | Blob,
        opts?: { contentType?: string; upsert?: boolean },
      ): Promise<{ data: unknown; error: { message: string } | null }>;
      download(path: string): Promise<{
        data: { arrayBuffer(): Promise<ArrayBuffer> } | null;
        error: { message: string } | null;
      }>;
      createSignedUrl(
        path: string,
        ttlSec: number,
      ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
      createSignedUploadUrl(
        path: string,
      ): Promise<{
        data: { signedUrl: string; path: string; token: string } | null;
        error: { message: string } | null;
      }>;
    };
    createBucket(
      name: string,
      opts?: { public?: boolean; fileSizeLimit?: number },
    ): Promise<{ data: unknown; error: { message: string } | null }>;
    updateBucket(
      name: string,
      opts: { public?: boolean; fileSizeLimit?: number | null; allowedMimeTypes?: string[] | null },
    ): Promise<{ data: unknown; error: { message: string } | null }>;
    getBucket(
      name: string,
    ): Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

const URI_PREFIX = 'supabase://';

export interface SupabaseStorageDeps {
  client: SupabaseClientLike;
  bucket: string;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export class SupabaseStorage {
  constructor(private readonly deps: SupabaseStorageDeps) {}

  /** Parse a `supabase://<bucket>/<path>` URI; throws on malformed input. */
  static parseUri(uri: string): { bucket: string; path: string } {
    if (!uri.startsWith(URI_PREFIX)) {
      throw new Error(`invalid supabase URI: ${uri}`);
    }
    const tail = uri.slice(URI_PREFIX.length);
    const slash = tail.indexOf('/');
    if (slash <= 0) throw new Error(`invalid supabase URI: ${uri}`);
    return { bucket: tail.slice(0, slash), path: tail.slice(slash + 1) };
  }

  /** Compose a self-describing URI for a path inside this storage's bucket. */
  toUri(path: string): string {
    return `${URI_PREFIX}${this.deps.bucket}/${path}`;
  }

  /**
   * Upload a ciphertext blob. Idempotent on `path` (upsert: true).
   * Caller is responsible for encryption; we store bytes verbatim.
   */
  async upload(
    buf: Buffer,
    path: string,
    contentType = 'application/octet-stream',
  ): Promise<string> {
    const { error } = await this.deps.client.storage
      .from(this.deps.bucket)
      .upload(path, buf, { contentType, upsert: true });
    if (error) throw new Error(`supabase upload failed: ${error.message}`);
    this.deps.logger?.info({ path, bytes: buf.length }, 'supabase:upload');
    return this.toUri(path);
  }

  /** Download a ciphertext blob by URI. */
  async download(uri: string): Promise<Buffer> {
    const { bucket, path } = SupabaseStorage.parseUri(uri);
    const { data, error } = await this.deps.client.storage
      .from(bucket)
      .download(path);
    if (error || !data) {
      throw new Error(`supabase download failed: ${error?.message ?? 'no data'}`);
    }
    return Buffer.from(await data.arrayBuffer());
  }

  /**
   * Issue a time-bound signed URL for a blob. Default TTL 15 minutes.
   * Caller fetches the URL directly; we never proxy bytes.
   */
  async signedUrl(uri: string, ttlSec = 900): Promise<string> {
    const { bucket, path } = SupabaseStorage.parseUri(uri);
    const { data, error } = await this.deps.client.storage
      .from(bucket)
      .createSignedUrl(path, ttlSec);
    if (error || !data) {
      throw new Error(`supabase signed-url failed: ${error?.message ?? 'no url'}`);
    }
    return data.signedUrl;
  }

  /**
   * Mint a one-shot signed PUT URL the *client* can upload to directly.
   * Used by /v3/agents/:id/uploads so the API never proxies large files
   * (high-perf: zero bytes through Express). Path is bucket-relative.
   *
   * Throws on Supabase error so callers can surface 5xx with context.
   */
  async signedUploadUrl(
    path: string,
  ): Promise<{ signedUrl: string; storageUri: string; token: string }> {
    const { data, error } = await this.deps.client.storage
      .from(this.deps.bucket)
      .createSignedUploadUrl(path);
    if (error || !data) {
      throw new Error(`supabase signed-upload-url failed: ${error?.message ?? 'no url'}`);
    }
    return {
      signedUrl: data.signedUrl,
      storageUri: this.toUri(path),
      token: data.token,
    };
  }

  /**
   * Idempotent bucket creation. Errors with messages containing "exists"
   * (Supabase's wording for already-created buckets) are swallowed so this
   * is safe to call on every boot. Any other error propagates.
   *
   * When the bucket already exists, `updateBucket` is invoked to reconcile
   * its `fileSizeLimit` and `allowedMimeTypes` with the caller's intent —
   * this matters when a previous deploy created the bucket with a stale
   * 50 MB cap and the new policy is "unlimited" (`fileSizeLimit: undefined`
   * → null on the wire). Update errors are logged but never throw, so the
   * mint path stays available even on read-only service-role keys.
   */
  async ensureBucket(opts: { public?: boolean; fileSizeLimit?: number } = {}): Promise<void> {
    const probe = await this.deps.client.storage.getBucket(this.deps.bucket);
    if (probe.data) {
      // Bucket already exists — reconcile policy. `fileSizeLimit: undefined`
      // becomes `null` over the wire, which Supabase interprets as "no cap".
      // Same trick for `allowedMimeTypes`.
      const upd = await this.deps.client.storage.updateBucket(this.deps.bucket, {
        public: opts.public ?? false,
        fileSizeLimit: opts.fileSizeLimit ?? null,
        allowedMimeTypes: null,
      });
      if (upd.error) {
        this.deps.logger?.warn(
          { bucket: this.deps.bucket, err: upd.error.message },
          'supabase:bucket:update-skipped',
        );
      }
      return;
    }
    const { error } = await this.deps.client.storage.createBucket(this.deps.bucket, {
      public: opts.public ?? false,
      fileSizeLimit: opts.fileSizeLimit,
    });
    if (error && !/exists/i.test(error.message)) {
      throw new Error(`supabase ensureBucket failed: ${error.message}`);
    }
    this.deps.logger?.info({ bucket: this.deps.bucket }, 'supabase:bucket:ensured');
  }
}

let _singleton: SupabaseStorage | null = null;
let _taskUploads: SupabaseStorage | null = null;

/**
 * Resolve the Supabase project URL.
 *
 * Priority:
 *   1. explicit SUPABASE_URL env (canonical)
 *   2. derived from DATABASE_URL (Supabase pooler URL embeds the project ref
 *      as `postgres.<project-ref>` in the user). We auto-derive so single-
 *      tenant deploys don't need the same secret listed twice.
 *
 * Returns null when neither path produces a value.
 */
function resolveSupabaseUrl(): string | null {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL;
  const db = process.env.DATABASE_URL ?? '';
  const m = db.match(/postgres(?:ql)?:\/\/[^:]+\.([a-z0-9]+):/);
  return m ? `https://${m[1]}.supabase.co` : null;
}

/**
 * Typed sentinel error thrown when storage env is incomplete. Route
 * handlers should catch by `code` and return 503 with a clear message
 * instead of leaking the generic 500.
 */
export class StorageUnconfiguredError extends Error {
  readonly code = 'STORAGE_UNCONFIGURED' as const;
  constructor(missing: string) {
    super(`task uploads disabled: missing ${missing}`);
    this.name = 'StorageUnconfiguredError';
  }
}

function buildClient(bucket: string): SupabaseStorage {
  const url = resolveSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const missing = !url && !key
      ? 'SUPABASE_URL (or DATABASE_URL) + SUPABASE_SERVICE_ROLE_KEY'
      : !url
        ? 'SUPABASE_URL (could not derive from DATABASE_URL)'
        : 'SUPABASE_SERVICE_ROLE_KEY';
    throw new StorageUnconfiguredError(missing);
  }
  // Use @supabase/storage-js directly rather than @supabase/supabase-js's
  // createClient(). The full client eagerly initializes a Realtime
  // websocket connection which fails on Node 20 (no native WebSocket).
  // Storage is the only Supabase surface we use, so we drop the rest:
  // single concern, no transitive dependency on browser globals.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { StorageClient } = require('@supabase/storage-js');
  const storage = new StorageClient(`${url}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
  return new SupabaseStorage({ client: { storage }, bucket });
}

/**
 * Lazy-construct a singleton from env. Throws StorageUnconfiguredError
 * when env is incomplete — callers should catch by `code` and degrade
 * gracefully (e.g. workspace falls back to inline text uploads).
 */
export function getSupabaseStorage(): SupabaseStorage {
  if (_singleton) return _singleton;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'brain-blobs';
  _singleton = buildClient(bucket);
  return _singleton;
}

/**
 * Storage handle for ephemeral workspace uploads (50 MB cap, 24h TTL,
 * private bucket — signed URLs only). Separate from the brain-blobs bucket
 * so retention + access policies stay independent. Bucket is created
 * idempotently on first use.
 */
export function getTaskUploadsStorage(): SupabaseStorage {
  if (_taskUploads) return _taskUploads;
  const bucket = process.env.TASK_UPLOADS_BUCKET ?? 'task-uploads';
  _taskUploads = buildClient(bucket);
  return _taskUploads;
}
