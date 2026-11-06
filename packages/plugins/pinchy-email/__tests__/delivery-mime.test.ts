import { describe, it, expect } from "vitest";
import { deliveryMimeType, isServableDelivery } from "../delivery-mime.js";

describe("deliveryMimeType", () => {
  it("keeps a servable declared type", () => {
    expect(deliveryMimeType("application/pdf", "invoice.pdf")).toBe("application/pdf");
  });

  it("lower-cases the declared type and drops its parameters", () => {
    expect(deliveryMimeType("Text/CSV; charset=UTF-8", "export.csv")).toBe("text/csv");
    expect(deliveryMimeType("IMAGE/PNG", "scan.png")).toBe("image/png");
  });

  it("derives the type from the extension when the declared one is a generic label", () => {
    expect(deliveryMimeType("application/octet-stream", "ledger.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(deliveryMimeType("application/vnd.ms-excel", "Export.CSV")).toBe("text/csv");
    expect(deliveryMimeType("", "notes.md")).toBe("text/markdown");
    expect(deliveryMimeType(undefined, "photo.JPG")).toBe("image/jpeg");
  });

  it("does not let the extension override a specific declared type", () => {
    // A Word document named .pdf is still a Word document: claiming PDF would
    // mint a chip the serving route then refuses (it sniffs the bytes).
    expect(
      deliveryMimeType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "contract.pdf"
      )
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("leaves a non-servable type non-servable", () => {
    expect(deliveryMimeType("application/vnd.ms-excel", "legacy.xls")).toBe(
      "application/vnd.ms-excel"
    );
    expect(deliveryMimeType("application/zip", "bundle.zip")).toBe("application/zip");
    expect(deliveryMimeType("application/octet-stream", "blob.bin")).toBe(
      "application/octet-stream"
    );
    expect(deliveryMimeType(undefined, "no-extension")).toBe("application/octet-stream");
  });
});

describe("isServableDelivery", () => {
  it("answers for normalized types", () => {
    expect(isServableDelivery("application/pdf")).toBe(true);
    expect(isServableDelivery("text/csv")).toBe(true);
    expect(isServableDelivery("application/msword")).toBe(false);
    expect(isServableDelivery("application/octet-stream")).toBe(false);
  });
});
