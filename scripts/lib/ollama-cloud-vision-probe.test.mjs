import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VISION_FIXTURE_NUMBER,
  VISION_FIXTURE_COLOR,
  buildVisionProbeRequest,
  readsFixture,
  classifyVisionResponse,
} from "./ollama-cloud-vision-probe.mjs";

const REJECTION = JSON.stringify({
  error: "this model does not support image input (ref: abc)",
});
const SERVER_ERROR = JSON.stringify({
  error: "Internal Server Error (ref: abc)",
});

function reply(content, extra = {}) {
  return JSON.stringify({
    id: "chatcmpl-641",
    created: 1785414897,
    choices: [{ index: 0, message: { role: "assistant", content, ...extra } }],
  });
}

test("the fixture ground truth is a 4-digit number and a colour", () => {
  assert.match(VISION_FIXTURE_NUMBER, /^\d{4}$/);
  assert.equal(typeof VISION_FIXTURE_COLOR, "string");
  assert.ok(VISION_FIXTURE_COLOR.length > 2);
});

test("buildVisionProbeRequest asks for both ground-truth facts and sends the image", () => {
  const req = buildVisionProbeRequest(
    "kimi-k2.6",
    "data:image/png;base64,AAAA",
  );
  assert.equal(req.model, "kimi-k2.6");
  const parts = req.messages[0].content;
  const image = parts.find((p) => p.type === "image_url");
  assert.equal(image.image_url.url, "data:image/png;base64,AAAA");
  const text = parts.find((p) => p.type === "text").text;
  assert.match(text, /number/i);
  assert.match(text, /colou?r/i);
});

// A thinking model spends its output budget on reasoning before it answers.
// With the old max_tokens:16 the visible content came back EMPTY and a
// ground-truth check would have read that as "blind" — a false drift on
// kimi-k2.5 / k2.6 / k2.7-code, all of which read the fixture correctly when
// given room (verified live 2026-07-30).
test("the output budget is large enough for a thinking model to finish", () => {
  const req = buildVisionProbeRequest(
    "kimi-k2.6",
    "data:image/png;base64,AAAA",
  );
  assert.ok(
    req.max_tokens >= 256,
    `max_tokens ${req.max_tokens} is too small for a thinking model to emit an answer`,
  );
});

test("readsFixture finds the number in visible content", () => {
  assert.equal(
    readsFixture(reply(`NUMBER=${VISION_FIXTURE_NUMBER} COLOR=blue`)),
    true,
  );
  assert.equal(readsFixture(reply("NUMBER=1234 COLOR=red")), false);
});

// Thinking models put the answer in `reasoning` / `reasoning_content` and may
// leave `content` empty. Missing those fields would misreport a sighted model.
test("readsFixture also looks at reasoning fields", () => {
  assert.equal(
    readsFixture(reply("", { reasoning: `I see ${VISION_FIXTURE_NUMBER}` })),
    true,
  );
  assert.equal(
    readsFixture(
      reply("", { reasoning_content: `it says ${VISION_FIXTURE_NUMBER}` }),
    ),
    true,
  );
});

// The number must be matched in model *prose* only. Searching the raw body
// would let an `id` or a `created` timestamp that happens to contain the digits
// pass as sight — a false OK that hides a blind model.
test("readsFixture ignores digits that appear only in envelope metadata", () => {
  const body = JSON.stringify({
    id: `chatcmpl-${VISION_FIXTURE_NUMBER}`,
    created: Number(`178${VISION_FIXTURE_NUMBER}897`),
    choices: [{ message: { role: "assistant", content: "I cannot tell." } }],
  });
  assert.equal(readsFixture(body), false);
});

test("readsFixture survives a non-JSON body", () => {
  assert.equal(readsFixture("<html>502 Bad Gateway</html>"), false);
});

test("vision:true that reads the fixture is OK", () => {
  const v = classifyVisionResponse({
    flag: true,
    status: 200,
    body: reply(
      `NUMBER=${VISION_FIXTURE_NUMBER} COLOR=${VISION_FIXTURE_COLOR}`,
    ),
  });
  assert.equal(v.verdict, "ok");
});

// The dangerous case the library tags hide, and the reason this probe exists:
// HTTP 200 with hallucinated contents. qwen3.5:397b behaved exactly like this
// in 2026-06 while its library page advertised image input.
test("vision:true that accepts the image but misreads it is DRIFT", () => {
  const v = classifyVisionResponse({
    flag: true,
    status: 200,
    body: reply("NUMBER=1234 COLOR=red"),
  });
  assert.equal(v.verdict, "drift");
  assert.match(v.detail, /blind|cannot read|misread/i);
});

test("vision:true that the API rejects is DRIFT", () => {
  const v = classifyVisionResponse({
    flag: true,
    status: 400,
    body: REJECTION,
  });
  assert.equal(v.verdict, "drift");
});

test("vision:false that the API rejects is OK", () => {
  const v = classifyVisionResponse({
    flag: false,
    status: 400,
    body: REJECTION,
  });
  assert.equal(v.verdict, "ok");
});

// Flag and reality agree: Pinchy never hands this model an image, and the model
// could not read one anyway. Reporting this as drift (as the pre-2026-07-30
// probe did for every flag=false 200) buries the real signal below.
test("vision:false that accepts but cannot read is OK", () => {
  const v = classifyVisionResponse({
    flag: false,
    status: 200,
    body: reply("I'm not able to view images."),
  });
  assert.equal(v.verdict, "ok");
  assert.match(v.detail, /blind|cannot read/i);
});

test("vision:false that genuinely reads the fixture is DRIFT — a promotion candidate", () => {
  const v = classifyVisionResponse({
    flag: false,
    status: 200,
    body: reply(
      `NUMBER=${VISION_FIXTURE_NUMBER} COLOR=${VISION_FIXTURE_COLOR}`,
    ),
  });
  assert.equal(v.verdict, "drift");
  assert.match(v.detail, /promot|reads/i);
});

// A 500 is neither a capability statement nor a rejection. It must never be
// read as "rejects images": that is what let kimi-k2.7-code sit at
// vision:false for a month while the model could in fact see (#the 2026-07-30
// sweep), and it is what the dead 64x64 fixture provoked on six models at once.
test("a persistent server error is UNEXPECTED, never a rejection", () => {
  for (const flag of [true, false]) {
    const v = classifyVisionResponse({ flag, status: 500, body: SERVER_ERROR });
    assert.equal(
      v.verdict,
      "unexpected",
      `flag=${flag} must not classify as ok/drift`,
    );
    assert.match(v.detail, /500/);
  }
});

// The fixture-decode failure has its own signature and its own remedy
// (regenerate the fixture), so it must not be reported as a model defect.
test("an image-decode complaint names the fixture, not the model", () => {
  const v = classifyVisionResponse({
    flag: true,
    status: 400,
    body: JSON.stringify({
      error:
        "InternalError.Algo.InvalidParameter: The image format is illegal and cannot be opened",
    }),
  });
  assert.equal(v.verdict, "fixture-rejected");
  assert.match(v.detail, /fixture/i);
});
