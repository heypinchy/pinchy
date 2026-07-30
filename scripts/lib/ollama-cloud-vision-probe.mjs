// Pure helpers for the Ollama Cloud vision probe.
//
// `verify-ollama-cloud-vision.mjs` POSTs the pinned fixture image to
// https://ollama.com/v1/chat/completions for each curated model and checks the
// reply against the model's `vision` flag. This file holds the request shape and
// the response classifier, kept pure so the network wrapper stays thin and the
// interesting logic is unit-tested — the same split as
// ollama-cloud-tool-probe.mjs.
//
// Why the classifier is more than "HTTP 200?": the failure this probe exists to
// catch is a model that ACCEPTS an image and then invents its contents. That
// returns 200 and looks healthy. qwen3.5:397b did exactly this through 2026-06
// while its library page advertised image input, and only a ground-truth check
// (does the answer contain the number that is actually in the picture?) tells
// sight from confabulation. So the fixture carries a 4-digit number and a
// coloured circle, and "reads the fixture" means the number comes back.
//
// Guessing a specific 4-digit number is ~1/9000 per attempt, which is what makes
// a single sighted answer trustworthy while a single "blue" would not be — there
// are only a handful of plausible colours to guess from.

/** The number rendered in scripts/lib/vision-probe-fixture.png. */
export const VISION_FIXTURE_NUMBER = "7413";
/** The colour of the circle in that same fixture. */
export const VISION_FIXTURE_COLOR = "blue";

/**
 * Provider replies that mean "this model has no image input", as opposed to a
 * transport failure or a complaint about our fixture.
 */
const NOT_SUPPORTED_PATTERNS = [
  /image input is not enabled/i,
  /this model does not support image input/i,
  /does not support images/i,
];

/**
 * Provider replies that mean "your image could not be decoded". These describe
 * OUR fixture, never the model's capability, and they are reported separately so
 * nobody edits a catalog flag over a broken picture.
 *
 * This is not hypothetical: the 64x64 PNG this probe shipped until 2026-07-30
 * became undecodable to Ollama's backends, and the resulting sweep reported six
 * of eighteen models as vision drift. Acting on that report would have flipped
 * six correct flags and broken the image-fallback chain.
 */
const FIXTURE_REJECTED_PATTERNS = [
  /image format is illegal/i,
  /cannot be opened/i,
  /unable to process input image/i,
  /invalid image/i,
  /image.{0,40}too (small|large)/i,
  /failed to decode/i,
];

/**
 * Build the probe request body.
 *
 * `max_tokens` is deliberately generous. A thinking model spends its budget on
 * reasoning before it writes anything visible, so the old 16-token budget
 * returned empty content for the whole kimi line — which a ground-truth check
 * would read as "blind". 512 leaves room for the reasoning plus a one-line
 * answer.
 *
 * @param {string} id model id, already allow-list checked by the caller
 * @param {string} dataUrl `data:image/png;base64,…` fixture
 */
export function buildVisionProbeRequest(id, dataUrl) {
  return {
    model: id,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Read the 4-digit number written in this image and name the colour " +
              "of the circle. Answer exactly: NUMBER=<digits> COLOR=<colour>",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };
}

/**
 * Collect the text the MODEL wrote, ignoring the response envelope.
 *
 * Envelope fields matter: `id` and `created` are digit soup, and searching the
 * raw body for the fixture number would let a timestamp masquerade as sight —
 * a false OK that hides exactly the blindness this probe hunts. Reasoning
 * fields are included because thinking models answer there and leave `content`
 * empty.
 *
 * @param {string} bodyText
 */
function modelProse(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return "";
  }
  const chunks = [];
  for (const choice of parsed?.choices ?? []) {
    const msg = choice?.message ?? {};
    for (const field of ["content", "reasoning", "reasoning_content"]) {
      if (typeof msg[field] === "string") chunks.push(msg[field]);
    }
    if (typeof choice?.text === "string") chunks.push(choice.text);
  }
  return chunks.join("\n");
}

/**
 * True when the model reported the number that is actually in the fixture.
 * @param {string} bodyText raw response body
 */
export function readsFixture(bodyText) {
  return modelProse(bodyText).includes(VISION_FIXTURE_NUMBER);
}

function matches(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * Compare one probe result against the catalog flag.
 *
 * Verdicts:
 * - `ok` — flag and observed behaviour agree.
 * - `drift` — they disagree; the detail says which way, so the fix is obvious.
 * - `fixture-rejected` — the provider refused our image. Our problem, not the
 *   model's; regenerate the fixture.
 * - `unexpected` — anything else (notably a persistent 5xx), which is a
 *   statement about neither capability nor flag. Never silently an "ok": a 500
 *   read as "rejects images" is what kept kimi-k2.7-code at vision:false for a
 *   month while the model could actually see.
 *
 * @param {{flag: boolean, status: number, body: string}} result
 */
export function classifyVisionResponse({ flag, status, body }) {
  const bodyText = typeof body === "string" ? body : "";

  if (status >= 400 && matches(FIXTURE_REJECTED_PATTERNS, bodyText)) {
    return {
      verdict: "fixture-rejected",
      detail:
        `HTTP ${status}: the provider could not decode the probe fixture. ` +
        "This says nothing about the model — regenerate vision-probe-fixture.png " +
        "and re-run before touching any catalog flag.",
    };
  }

  const rejectsImages =
    status >= 400 && matches(NOT_SUPPORTED_PATTERNS, bodyText);
  const sees = status === 200 && readsFixture(bodyText);

  if (status === 200) {
    if (flag && sees) {
      return {
        verdict: "ok",
        detail: `api accepts and read the fixture number ${VISION_FIXTURE_NUMBER}`,
      };
    }
    if (flag && !sees) {
      return {
        verdict: "drift",
        detail:
          "flag=true but the model accepted the image and could not read it " +
          `(no ${VISION_FIXTURE_NUMBER} in its answer) — blind acceptance, the ` +
          "qwen3.5 failure mode. Set vision:false unless a re-probe reads it.",
      };
    }
    if (!flag && sees) {
      return {
        verdict: "drift",
        detail:
          "flag=false but the model genuinely reads images — a promotion " +
          "candidate. Confirm over several trials, then set vision:true.",
      };
    }
    return {
      verdict: "ok",
      detail:
        "api accepts images but cannot read them (blind) — flag=false already " +
        "matches, so Pinchy never hands it an image",
    };
  }

  if (rejectsImages) {
    return flag
      ? {
          verdict: "drift",
          detail: `flag=true but the API rejects images (HTTP ${status})`,
        }
      : { verdict: "ok", detail: "api rejects images" };
  }

  return {
    verdict: "unexpected",
    detail:
      `HTTP ${status} is neither a successful read nor an image-input rejection` +
      (status >= 500
        ? " — server-side fault, retry before concluding anything"
        : ""),
  };
}
