import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadBundle, buildBundleFilename } from "@/lib/diagnostics/download";

describe("downloadBundle", () => {
  const originalCreateObjectURL = global.URL.createObjectURL;
  const originalRevokeObjectURL = global.URL.revokeObjectURL;

  beforeEach(() => {
    global.URL.createObjectURL = vi.fn(() => "blob:fake-url");
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    global.URL.createObjectURL = originalCreateObjectURL;
    global.URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it("creates a Blob with application/json mime type", () => {
    downloadBundle({ schemaVersion: "pinchy.bugreport.v1" }, "pinchy-bugreport-x.json");

    const createObjectURL = global.URL.createObjectURL as ReturnType<typeof vi.fn>;
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
  });

  it("uses the given filename in the anchor download attribute", () => {
    const anchor = document.createElement("a");
    const clickSpy = vi.spyOn(anchor, "click").mockImplementation(() => {});
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        if (tag === "a") return anchor;
        return document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
      });

    downloadBundle({ schemaVersion: "pinchy.bugreport.v1" }, "expected-filename.json");

    expect(createElementSpy).toHaveBeenCalledWith("a");
    expect(anchor.download).toBe("expected-filename.json");
    expect(anchor.href).toContain("blob:fake-url");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("revokes the object URL after triggering the download", () => {
    downloadBundle({ schemaVersion: "pinchy.bugreport.v1" }, "cleanup.json");

    const revokeObjectURL = global.URL.revokeObjectURL as ReturnType<typeof vi.fn>;
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
  });
});

describe("buildBundleFilename", () => {
  it("slugifies the agent name and stamps the date", () => {
    const filename = buildBundleFilename("My Smithers!", new Date("2026-05-20T14:30:00Z"));
    expect(filename).toMatch(/^pinchy-bugreport-my-smithers-20260520-1430\.json$/);
  });

  it("strips special chars and leading/trailing dashes from the slug", () => {
    const filename = buildBundleFilename(
      "---!!! Hello, World!! ---",
      new Date("2026-01-02T03:04:05Z")
    );
    expect(filename).toBe("pinchy-bugreport-hello-world-20260102-0304.json");
  });

  it("lowercases mixed-case agent names", () => {
    const filename = buildBundleFilename("AcmeBot", new Date("2026-12-31T23:59:59Z"));
    expect(filename).toBe("pinchy-bugreport-acmebot-20261231-2359.json");
  });
});
