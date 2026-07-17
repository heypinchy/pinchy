import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// server.js is CommonJS and exports a testable core. Importing it does NOT
// boot the HTTPS/control servers (guarded by `require.main === module`), so
// no ports are bound — this runs hermetically under `node --test`.
const require = createRequire(import.meta.url);
const {
  resetState,
  injectMessage,
  handleGetUpdates,
  handleBotRequest,
  getFileBytes,
} = require("../server.js");

const TOKEN = "123456:ABC-test-token-for-e2e";
const CHAT_ID = "999888777";

function injectPhoto(opts = {}) {
  return injectMessage({
    token: TOKEN,
    chatId: CHAT_ID,
    userId: CHAT_ID,
    username: "e2e_tester",
    firstName: "E2E",
    lastName: "Tester",
    photo: true,
    ...opts,
  });
}

// injectMessage doesn't return the built update, only its id — pull the
// queued message back out through handleGetUpdates (already exercised for
// correctness by the sibling reset-offset suite) instead of reaching into
// module-private state.
async function lastQueuedMessage(token) {
  const res = await handleGetUpdates(token, { offset: "0", timeout: "0" });
  const updates = res.result || [];
  return updates[updates.length - 1].message;
}

test("photo control message queues an update with a multi-size photo array, caption, and no text", async () => {
  resetState();

  injectPhoto({ caption: "receipt" });
  const message = await lastQueuedMessage(TOKEN);

  assert.ok(
    Array.isArray(message.photo),
    "expected message.photo to be an array",
  );
  assert.ok(message.photo.length >= 2, "expected at least 2 PhotoSize entries");

  const sizes = message.photo.map((p) => p.width * p.height);
  const distinctSizes = new Set(sizes);
  assert.equal(
    distinctSizes.size,
    message.photo.length,
    "expected distinct sizes",
  );

  // Ascending small -> large, per real Bot API ordering.
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(
      sizes[i] > sizes[i - 1],
      "expected photo sizes sorted small to large",
    );
  }

  for (const size of message.photo) {
    assert.equal(typeof size.file_id, "string");
    assert.equal(typeof size.file_unique_id, "string");
    assert.equal(typeof size.width, "number");
    assert.equal(typeof size.height, "number");
  }

  assert.equal(message.caption, "receipt");
  assert.ok(!("text" in message), "expected no text key on a photo message");
});

test("photo control message without a caption has no caption key", async () => {
  resetState();

  injectPhoto();
  const message = await lastQueuedMessage(TOKEN);

  assert.ok(
    !("caption" in message),
    "expected no caption key when none was provided",
  );
  assert.ok(!("text" in message), "expected no text key on a photo message");
});

test("existing text messages are unaffected by photo support", async () => {
  resetState();

  injectMessage({
    token: TOKEN,
    chatId: CHAT_ID,
    text: "hi",
    userId: CHAT_ID,
    username: "e2e_tester",
    firstName: "E2E",
    lastName: "Tester",
  });
  const message = await lastQueuedMessage(TOKEN);

  assert.equal(message.text, "hi");
  assert.ok(!("photo" in message), "expected no photo key on a text message");
  assert.ok(
    !("caption" in message),
    "expected no caption key on a text message",
  );
});

test("getFile returns the file_path for the largest PhotoSize's file_id", async () => {
  resetState();

  injectPhoto({ caption: "receipt" });
  const message = await lastQueuedMessage(TOKEN);
  const largest = message.photo[message.photo.length - 1];

  const result = handleBotRequest(TOKEN, "getFile", {
    file_id: largest.file_id,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.file_id, largest.file_id);
  assert.match(result.result.file_path, /^photos\/file_\d+\.jpg$/);
});

test("getFile with an unknown file_id returns a 400 error", async () => {
  resetState();

  const result = handleBotRequest(TOKEN, "getFile", {
    file_id: "nonexistent-file-id",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 400);
});

test("downloading a photo's file_path returns bytes starting with the JPEG magic number", async () => {
  resetState();

  injectPhoto({ caption: "receipt" });
  const message = await lastQueuedMessage(TOKEN);
  const largest = message.photo[message.photo.length - 1];

  const fileResult = handleBotRequest(TOKEN, "getFile", {
    file_id: largest.file_id,
  });
  const bytes = getFileBytes(fileResult.result.file_path);

  assert.ok(
    bytes,
    "expected file bytes to be found for the returned file_path",
  );
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  assert.equal(bytes[2], 0xff);
});
