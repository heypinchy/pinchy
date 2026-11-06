import { describe, it, expect } from "vitest";
import { readBodyWithLimit } from "@/lib/read-body-limit";

function streamOf(chunks: number[][], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(new Uint8Array(chunks[i++]));
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe("readBodyWithLimit", () => {
  it("returns an empty buffer for a request without a body", async () => {
    const out = await readBodyWithLimit(null, 10);
    expect(out).toEqual(new Uint8Array(0));
  });

  it("returns a body of exactly the limit", async () => {
    const out = await readBodyWithLimit(
      streamOf([
        [1, 2, 3],
        [4, 5],
      ]),
      5
    );
    expect(out).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("refuses a body one byte over the limit", async () => {
    expect(
      await readBodyWithLimit(
        streamOf([
          [1, 2, 3],
          [4, 5, 6],
        ]),
        5
      )
    ).toBeNull();
  });

  it("reassembles many chunks in order", async () => {
    const chunks = [[1], [2, 3], [], [4, 5, 6], [7]];
    const out = await readBodyWithLimit(streamOf(chunks), 100);
    expect(out).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
  });

  it("cancels the stream once the limit is passed, so nothing more is read", async () => {
    let cancelled = false;
    const out = await readBodyWithLimit(
      streamOf(
        [
          [1, 2],
          [3, 4],
          [5, 6],
          [7, 8],
        ],
        () => {
          cancelled = true;
        }
      ),
      3
    );
    expect(out).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("rejects when the stream errors mid-read, so the route can answer 400", async () => {
    let sent = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array([1]));
        } else {
          controller.error(new Error("connection reset"));
        }
      },
    });
    await expect(readBodyWithLimit(failing, 10)).rejects.toThrow("connection reset");
  });
});
