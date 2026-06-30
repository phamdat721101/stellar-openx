/**
 * llm.ts — single provider-routing adapter for chat-style LLM calls.
 *
 * One function: `llmChat({ system, user, jsonMode?, model? })`.
 *
 * Routing:
 *   • model id starts with `anthropic.` or `us.anthropic.` (or any other
 *     non-OpenAI-compat Bedrock id) → Bedrock Converse API
 *     (`https://bedrock-runtime.{region}.amazonaws.com/model/{id}/converse`).
 *   • everything else → OpenAI-compatible /chat/completions at `OPENAI_BASE_URL`.
 *
 * Auth: a single Bearer header — `BEDROCK_API_KEY` or `OPENAI_API_KEY`. The
 * 2024 Bedrock long-term API keys accept the same `Authorization: Bearer …`
 * shape, so the only branch is request/response payload shape.
 *
 * SOLID:
 *   • SRP — owns "talk to a chat LLM". Knows about two payload dialects and
 *     nothing else (no agent logic, no DB, no business rules).
 *   • OCP — adding a new provider = one new private function + one branch.
 *   • DIP — callers depend on this module's `llmChat`, not on fetch URLs or
 *     provider-specific request shapes.
 */

const REGION = process.env.BEDROCK_REGION ?? 'us-east-1';

export interface LlmChatOptions {
  system: string;
  user: string;
  /** Force JSON-object output. For Bedrock/Claude we inject a hint into the
   *  system prompt; for OpenAI-compat we set response_format. */
  jsonMode?: boolean;
  /** Override the env-default model id. */
  model?: string;
  /** Sampling temperature. Default 0.2 (good for both extract + rank). */
  temperature?: number;
  /** Token cap. Default 2048. */
  maxTokens?: number;
}

export async function llmChat(opts: LlmChatOptions): Promise<string> {
  const model = opts.model ?? process.env.OPENX_DEFAULT_MODEL ?? '';
  if (!model) return demoFallback(opts);

  if (isBedrockNativeModel(model)) {
    return bedrockConverse(model, opts);
  }
  return openaiCompat(model, opts);
}

// ─── Bedrock Converse (Anthropic Claude, Amazon Nova, etc.) ───────────────

async function bedrockConverse(model: string, opts: LlmChatOptions): Promise<string> {
  const key = process.env.BEDROCK_API_KEY;
  if (!key) return demoFallback(opts);
  const url = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
  const system = opts.jsonMode
    ? `${opts.system}\n\nReturn STRICT JSON only. No prose, no markdown fences.`
    : opts.system;
  const body = {
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: opts.user }] }],
    inferenceConfig: {
      maxTokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.2,
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`bedrock:${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    output?: { message?: { content?: Array<{ text?: string }> } };
  };
  return data.output?.message?.content?.[0]?.text ?? '';
}

// ─── OpenAI-compatible (gpt-oss / qwen3 / open router / OpenAI itself) ────

async function openaiCompat(model: string, opts: LlmChatOptions): Promise<string> {
  const key = process.env.OPENAI_API_KEY ?? process.env.BEDROCK_API_KEY;
  if (!key) return demoFallback(opts);
  const base = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`openai:${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? '';
}

// ─── helpers ──────────────────────────────────────────────────────────────

function isBedrockNativeModel(model: string): boolean {
  // Anthropic Claude (any version), Amazon Nova, and most non-OpenAI Bedrock
  // base / inference-profile ids land here. The OpenAI-compat shim only
  // supports a curated subset (gpt-oss, qwen3, deepseek, mistral, gemma, etc.).
  return /^(us\.)?(anthropic|amazon)\./.test(model);
}

function demoFallback({ jsonMode, user }: LlmChatOptions): string {
  if (jsonMode) {
    return JSON.stringify({
      name: 'demo agent',
      description: user.slice(0, 200),
      endpoint_url: 'https://example.com/api',
      price_usdc: 0.05,
      category: 'other',
      extraction_confidence: 0.5,
      clarification: 'LLM not configured — set BEDROCK_API_KEY or OPENAI_API_KEY.',
    });
  }
  return `[demo] (no LLM configured) — would answer: "${user.slice(0, 200)}"`;
}
