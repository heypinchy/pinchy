// @vitest-environment node
//
// jsdom's Request/FormData polyfill hangs on `request.formData()` for a
// multipart body (see sibling share-target/SW tests for the same fix) — run
// this route test under Node's native fetch implementation instead.
import { describe, it, expect } from "vitest";
import { POST } from "@/app/share-target/route";

// Task 6 of "Share to Pinchy": if a device is still running the OLD no-op
// service worker for a moment after a release (until the new one activates),
// the browser's `POST /share-target` reaches the network instead of the SW.
// Without this route that's a 404 and the shared file is silently lost. This
// route can't recover the file server-side — it drains the body so the
// connection closes cleanly and redirects the user to retry sharing.
describe("POST /share-target (SW-miss fallback)", () => {
  it("redirects to /share?error=retry with no body", async () => {
    const request = new Request("https://app.example/share-target", { method: "POST" });

    const response = await POST(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("/share?error=retry");
  });

  it("redirects to /share?error=retry when draining a multipart body", async () => {
    const formData = new FormData();
    formData.set("title", "Shared title");
    formData.set("file", new File(["file contents"], "shared.txt", { type: "text/plain" }));

    const request = new Request("https://app.example/share-target", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("/share?error=retry");
  });
});
