/**
 * @openx/sdk/zk/prover — snarkjs Groth16 wrapper for browser + Node.
 *
 * Loads the circuit's witness-gen `.wasm` and `.zkey` from the URLs the
 * caller supplies (Nethermind ships them under `deployments/testnet/
 * circuit_keys/`; operators host the pair as static assets). Returns a
 * `Groth16Proof` in the exact ScVal shape the Nethermind
 * `CircomGroth16Verifier` expects.
 *
 * SOLID:
 *  - SRP: prove(inputs) → proof + public signals. Nothing else.
 *  - DIP: snarkjs is dynamic-imported so this module is tree-shakeable and
 *    server-safe when the private tier is disabled.
 */

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: 'groth16';
  curve: 'bn128';
}

export interface ProveResult {
  proof: Groth16Proof;
  publicSignals: string[];
}

export interface ProverConfig {
  /** URL of the compiled circuit witness generator (`.wasm`). */
  wasmUrl: string;
  /** URL of the proving key (`.zkey`). */
  zkeyUrl: string;
}

/**
 * Prove a transaction against the pool circuit.
 *
 * `inputs` shape follows Nethermind's `policy_tx_2_2` (2-in 2-out) circuit —
 * see `docs/runbooks/ZK_DEPLOY.md` for the canonical field list.
 */
export async function prove(
  inputs: Record<string, unknown>,
  cfg: ProverConfig,
): Promise<ProveResult> {
  // Pre-fetch and validate both artifacts BEFORE handing them to snarkjs.
  // snarkjs' default error on a bad blob is a WebAssembly.compile magic-byte
  // trace ("expected magic word 00 61 73 6d, found 3c 21 44 4f" — the "<!DO"
  // of a Next.js 404 HTML page). We surface a specific operator-actionable
  // error instead. See docs/runbooks/ZK_DEPLOY.md.
  const [wasmBuf, zkeyBuf] = await Promise.all([
    fetchZkArtifact(cfg.wasmUrl, 'wasm'),
    fetchZkArtifact(cfg.zkeyUrl, 'zkey'),
  ]);
  const snarkjs = await loadSnarkjs();
  const signals = inputs as unknown as Parameters<typeof snarkjs.groth16.fullProve>[0];
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    signals,
    new Uint8Array(wasmBuf),
    new Uint8Array(zkeyBuf),
  );
  return { proof: proof as Groth16Proof, publicSignals: publicSignals as string[] };
}

/**
 * Validated fetch for a ZK circuit artifact.
 *
 * - Rejects non-200 responses with the URL in the error.
 * - Rejects HTML bodies (missing static file / SPA 404 fall-through) — the
 *   most common failure mode when operators forget to host the asset.
 * - Validates the magic bytes: wasm starts with `\0asm`, snarkjs zkey starts
 *   with the ASCII `zkey` tag. Anything else is a corrupt / wrong file.
 */
async function fetchZkArtifact(url: string, kind: 'wasm' | 'zkey'): Promise<ArrayBuffer> {
  const res = await fetch(url).catch((e) => {
    throw new Error(`zk-${kind}: network error fetching ${url} — ${(e as Error).message}`);
  });
  if (!res.ok) {
    throw new Error(
      `zk-${kind}: HTTP ${res.status} at ${url} — host the file under packages/frontend/public/circuits/ (see docs/runbooks/ZK_DEPLOY.md)`,
    );
  }
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf).subarray(0, 4);
  const isHtml = head[0] === 0x3c; // '<' — 404 / index.html fall-through
  if (isHtml) {
    throw new Error(
      `zk-${kind}: server returned HTML at ${url} (probably 404). Drop the file at packages/frontend/public/circuits/policy_tx_2_2${kind === 'wasm' ? '.wasm' : '_final.zkey'} — see docs/runbooks/ZK_DEPLOY.md`,
    );
  }
  const isWasm = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
  const isZkey = head[0] === 0x7a && head[1] === 0x6b && head[2] === 0x65 && head[3] === 0x79;
  // Nethermind ships their proving key in arkworks CanonicalSerialize format
  // (leading bytes e2 f2 6d be for the policy_tx_2_2 circuit) — NOT snarkjs
  // .zkey. Detect + surface the architectural decision, don't pretend to
  // work with the wrong file.
  const isArkBin = kind === 'zkey' && head[0] === 0xe2 && head[1] === 0xf2 && head[2] === 0x6d && head[3] === 0xbe;
  if (isArkBin) {
    throw new Error(
      `zk-zkey: ${url} is Nethermind's arkworks .bin proving key — not snarkjs-compatible. Pick a path in docs/runbooks/ZK_DEPLOY.md § 2 (A: adopt Nethermind's compiled prover, or B: deploy own contracts with own trusted setup).`,
    );
  }
  if (kind === 'wasm' && !isWasm) {
    throw new Error(`zk-wasm: bad magic bytes at ${url} — expected \\0asm, got ${hexHead(head)}`);
  }
  if (kind === 'zkey' && !isZkey) {
    throw new Error(`zk-zkey: bad magic bytes at ${url} — expected 'zkey', got ${hexHead(head)}. See docs/runbooks/ZK_DEPLOY.md § 2.`);
  }
  return buf;
}

function hexHead(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Local verification helper — mainly for smoke tests. The chain contract does
 * the real verification; this catches proving-side bugs before we spend a
 * Stellar tx fee.
 */
export async function verifyLocal(
  vkey: unknown,
  publicSignals: string[],
  proof: Groth16Proof,
): Promise<boolean> {
  const snarkjs = await loadSnarkjs();
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

let snarkjsPromise: Promise<typeof import('snarkjs')> | null = null;
function loadSnarkjs(): Promise<typeof import('snarkjs')> {
  if (!snarkjsPromise) snarkjsPromise = import('snarkjs');
  return snarkjsPromise;
}
