/**
 * Direct LLM API calls for describing scanned PDF page images.
 * Replicates the approach of OpenClaw's built-in PDF tool:
 * render pages to PNG → send to vision-capable LLM → get text back.
 */

const PROMPT =
  "Extract all text from this scanned document page. Return only the extracted text content, preserving the structure (headings, paragraphs, lists, tables). If you see tables, format them as markdown tables. Do not add commentary — only return the document text.";

const MAX_RETRIES = 3;

// Bounds a hung provider endpoint / network blackhole. The point of these is
// to make a blackhole terminate, NOT to enforce a latency budget — so they sit
// well above the legitimate worst case, because the cost of being wrong is
// asymmetric: too long merely delays an error, too short turns working page
// reads into failures nobody can distinguish from a broken PDF.
//
// A hosted vision call on a dense scanned page routinely runs tens of seconds
// (4096 max_tokens of extracted text at typical decode rates), so a 30s bound
// would abort real work.
const CLOUD_VISION_TIMEOUT_MS = 120_000;

// Ollama is the offline/self-hosted path and it is the slow one by design: the
// first request after a cold start pays the model load before any decoding
// begins, and CPU-only inference on a full page is minutes, not seconds.
// Sharing the hosted bound here would break exactly the deployments Pinchy
// promises to support.
const LOCAL_VISION_TIMEOUT_MS = 300_000;

// A malicious or misbehaving provider can send an arbitrarily large
// Retry-After (e.g. 86400 = 24h), which would otherwise put this PDF read to
// sleep for a day. Clamp to a sane range instead of trusting the header
// verbatim — at BOTH ends: a negative value is finite too, and `Math.min`
// alone passes it straight through.
const MAX_RETRY_AFTER_SECONDS = 30;

/**
 * Fetch with automatic retry on 429 (rate limit). Respects Retry-After header.
 *
 * `signal` is deliberately not accepted in `init`: the earlier shape did
 * `init.signal ?? AbortSignal.timeout(...)`, so the first caller to pass a
 * cancellation signal would have silently lost the timeout. A caller that
 * needs a different bound passes `timeoutMs`.
 */
async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number = CLOUD_VISION_TIMEOUT_MS
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Inside the loop on purpose: every attempt gets its own fresh bound,
    // rather than all attempts sharing one deadline that the first one spent.
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 429 || attempt === MAX_RETRIES) {
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after") || "1");
    const clampedSeconds = Math.min(
      Math.max(Number.isFinite(retryAfter) ? retryAfter : 1, 0),
      MAX_RETRY_AFTER_SECONDS
    );
    const waitMs = clampedSeconds * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  // unreachable, but TypeScript needs it
  throw new Error("fetchWithRetry: exceeded max retries");
}

export interface VisionApiConfig {
  resolveApiKey: (provider: string) => Promise<string | null>;
  model: string; // e.g. "anthropic/claude-haiku-4-5-20251001"
  /** Local Ollama server. No default: without a configured host there is nothing to call. */
  ollamaBaseUrl?: string;
  /** Ollama Cloud. Defaults to the canonical host — an override, not a requirement. */
  ollamaCloudBaseUrl?: string;
}

/** Ollama Cloud's single canonical host, mirroring `resolveProviderBaseUrl`'s fallback in web. */
const OLLAMA_CLOUD_DEFAULT_BASE_URL = "https://ollama.com";

/** Internal config that carries the OpenClaw cfg object */
export interface VisionApiInternalConfig {
  modelAuth: {
    resolveApiKeyForProvider: (params: {
      provider: string;
      cfg: unknown;
    }) => Promise<{ apiKey: string } | null>;
  };
  cfg: unknown;
  model: string;
}

/** Token usage returned from a vision API call. */
export interface VisionUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Result of a successful vision API call: extracted text plus token usage. */
export interface VisionResult {
  text: string;
  usage: VisionUsage;
}

/** Validate model ID to prevent URL injection (e.g. path traversal in Google API URL). */
function validateModelId(modelId: string): void {
  if (!modelId || /\.\./.test(modelId) || !/^[a-zA-Z0-9._:/-]+$/.test(modelId)) {
    throw new Error(`Invalid model ID: ${modelId}`);
  }
}

/**
 * Describe a scanned page image using the configured LLM's vision API.
 * Returns extracted text plus token usage, or null if vision is not available.
 */
export async function describePageImage(
  imageBase64: string,
  config: VisionApiConfig
): Promise<VisionResult | null> {
  const [provider, ...modelParts] = config.model.split("/");
  const modelId = modelParts.join("/");
  validateModelId(modelId);

  switch (provider) {
    case "anthropic":
      return describeViaAnthropic(imageBase64, modelId, config);
    case "openai":
      return describeViaOpenAI(imageBase64, modelId, config);
    case "google":
      return describeViaGoogle(imageBase64, modelId, config);
    case "ollama":
      return describeViaOllama(imageBase64, modelId, config);
    case "ollama-cloud":
      return describeViaOllamaCloud(imageBase64, modelId, config);
    default:
      return null;
  }
}

/**
 * Create a VisionApiConfig from OpenClaw's internal runtime APIs.
 */
export function createVisionConfig(internal: VisionApiInternalConfig): VisionApiConfig {
  const providers = (internal.cfg as Record<string, unknown>)?.models
    ? ((internal.cfg as any).models.providers as Record<string, { baseUrl?: string }> | undefined)
    : undefined;

  return {
    model: internal.model,
    ollamaBaseUrl: providers?.ollama?.baseUrl,
    // Emitted by build.ts as `<host>/v1`; the endpoint helper normalises that.
    ollamaCloudBaseUrl: providers?.["ollama-cloud"]?.baseUrl,
    resolveApiKey: async (provider: string) => {
      try {
        const result = await internal.modelAuth.resolveApiKeyForProvider({
          provider,
          cfg: internal.cfg,
        });
        return result?.apiKey ?? null;
      } catch (err) {
        console.error(`[pinchy-files] Failed to resolve API key for ${provider}:`, err);
        return null;
      }
    },
  };
}

async function describeViaAnthropic(
  imageBase64: string,
  modelId: string,
  config: VisionApiConfig
): Promise<VisionResult | null> {
  const apiKey = await config.resolveApiKey("anthropic");
  if (!apiKey) return null;

  const response = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageBase64,
              },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown error");
    console.error(`[pinchy-files] Anthropic vision API error (${response.status}):`, error);
    return null;
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text =
    data.content
      ?.filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n") ?? null;
  if (text === null) return null;
  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

async function describeViaOpenAI(
  imageBase64: string,
  modelId: string,
  config: VisionApiConfig
): Promise<VisionResult | null> {
  const apiKey = await config.resolveApiKey("openai");
  if (!apiKey) return null;

  const response = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${imageBase64}` },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown error");
    console.error(`[pinchy-files] OpenAI vision API error (${response.status}):`, error);
    return null;
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? null;
  if (text === null) return null;
  return {
    text,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

async function describeViaGoogle(
  imageBase64: string,
  modelId: string,
  config: VisionApiConfig
): Promise<VisionResult | null> {
  const apiKey = await config.resolveApiKey("google");
  if (!apiKey) return null;

  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: "image/png",
                  data: imageBase64,
                },
              },
              { text: PROMPT },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown error");
    console.error(`[pinchy-files] Google vision API error (${response.status}):`, error);
    return null;
  }

  const data = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text =
    data.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("\n") ?? null;
  if (text === null) return null;
  return {
    text,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

async function describeViaOllama(
  imageBase64: string,
  modelId: string,
  config: VisionApiConfig
): Promise<VisionResult | null> {
  // No default host: a local server lives wherever the operator put it, so an
  // unconfigured base URL means there is nothing to call.
  if (!config.ollamaBaseUrl) return null;

  return describeViaOllamaEndpoint({
    imageBase64,
    modelId,
    baseUrl: config.ollamaBaseUrl,
    apiKey: null,
    label: "Ollama",
    timeoutMs: LOCAL_VISION_TIMEOUT_MS,
  });
}

/**
 * Ollama Cloud speaks the same OpenAI-compatible dialect as the local server,
 * differing only in having one canonical host and requiring a bearer key.
 *
 * It reached this file late: the provider previously fell through to the
 * `default: return null` arm below, which was pinned by a test that recorded
 * the gap without explaining it. The gap was not harmless — Pinchy's own
 * `resolveDefaultVisionModelChain` emits `ollama-cloud/<id>` whenever that is
 * the configured stack, so the platform picked a vision model this consumer
 * could not call, and a scanned PDF produced no text with no error anywhere.
 */
async function describeViaOllamaCloud(
  imageBase64: string,
  modelId: string,
  config: VisionApiConfig
): Promise<VisionResult | null> {
  const apiKey = await config.resolveApiKey("ollama-cloud");
  if (!apiKey) return null;

  return describeViaOllamaEndpoint({
    imageBase64,
    modelId,
    // Unlike the local server, Ollama Cloud has ONE canonical host, so an
    // absent value is an override nobody set — not an unreachable provider.
    baseUrl: config.ollamaCloudBaseUrl ?? OLLAMA_CLOUD_DEFAULT_BASE_URL,
    apiKey,
    label: "Ollama Cloud",
    timeoutMs: CLOUD_VISION_TIMEOUT_MS,
  });
}

async function describeViaOllamaEndpoint(opts: {
  imageBase64: string;
  modelId: string;
  baseUrl: string;
  apiKey: string | null;
  label: string;
  timeoutMs: number;
}): Promise<VisionResult | null> {
  const { imageBase64, modelId, baseUrl, apiKey, label, timeoutMs } = opts;
  // Idempotent about `/v1`, mirroring `rewriteOllamaHostForOpenClaw`, which is
  // what produces the value the plugin receives: the emitted
  // `models.providers.ollama.baseUrl` already ends in `/v1` (pi-ai appends only
  // `/chat/completions`), so appending it again yielded `/v1/v1/…` and a 404 on
  // every scanned page. Callers that hold a bare host — the knowledge-base
  // ingest reads Pinchy's raw setting — are unaffected.
  const root = baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
  const url = `${root}/v1/chat/completions`;

  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${imageBase64}` },
              },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    },
    timeoutMs
  );

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown error");
    console.error(`[pinchy-files] ${label} vision API error (${response.status}):`, error);
    return null;
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? null;
  if (text === null) return null;
  return {
    text,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}
