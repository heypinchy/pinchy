/**
 * Direct LLM API calls for describing scanned PDF page images.
 * Replicates the approach of OpenClaw's built-in PDF tool:
 * render pages to PNG → send to vision-capable LLM → get text back.
 */

const PROMPT = "Extract all text from this scanned document page. Return only the extracted text content, preserving the structure (headings, paragraphs, lists, tables). If you see tables, format them as markdown tables. Do not add commentary — only return the document text.";

const MAX_RETRIES = 3;

/** Fetch with automatic retry on 429 (rate limit). Respects Retry-After header. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt === MAX_RETRIES) {
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after") || "1");
    const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  // unreachable, but TypeScript needs it
  throw new Error("fetchWithRetry: exceeded max retries");
}

export interface VisionApiConfig {
  resolveApiKey: (provider: string) => Promise<string | null>;
  model: string; // e.g. "anthropic/claude-haiku-4-5-20251001"
}

/** Internal config that carries the OpenClaw cfg object */
export interface VisionApiInternalConfig {
  modelAuth: {
    resolveApiKeyForProvider: (params: { provider: string; cfg: unknown }) => Promise<{ apiKey: string } | null>;
  };
  cfg: unknown;
  model: string;
}

/** Validate model ID to prevent URL injection (e.g. path traversal in Google API URL). */
function validateModelId(modelId: string): void {
  if (!modelId || /\.\./.test(modelId) || !/^[a-zA-Z0-9._:/-]+$/.test(modelId)) {
    throw new Error(`Invalid model ID: ${modelId}`);
  }
}

/**
 * Describe a scanned page image using the configured LLM's vision API.
 * Returns extracted text, or null if vision is not available.
 */
export async function describePageImage(
  imageBase64: string,
  config: VisionApiConfig,
): Promise<string | null> {
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
    default:
      return null;
  }
}

/**
 * Create a VisionApiConfig from OpenClaw's internal runtime APIs.
 */
export function createVisionConfig(internal: VisionApiInternalConfig): VisionApiConfig {
  return {
    model: internal.model,
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
  config: VisionApiConfig,
): Promise<string | null> {
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
  };
  return (
    data.content
      ?.filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n") ?? null
  );
}

async function describeViaOpenAI(
  imageBase64: string,
  modelId: string,
  config: VisionApiConfig,
): Promise<string | null> {
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
  };
  return data.choices?.[0]?.message?.content ?? null;
}

async function describeViaGoogle(
  imageBase64: string,
  modelId: string,
  config: VisionApiConfig,
): Promise<string | null> {
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
    },
  );

  if (!response.ok) {
    const error = await response.text().catch(() => "unknown error");
    console.error(`[pinchy-files] Google vision API error (${response.status}):`, error);
    return null;
  }

  const data = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
  };
  return (
    data.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("\n") ?? null
  );
}
