import { describe, it, expect } from "vitest";
import { generateFile } from "./generate-file";

describe("generateFile csv", () => {
  it("renders a BOM-prefixed RFC-4180 CSV with CRLF", () => {
    const { buffer, mimeType, ext } = generateFile({
      format: "csv",
      columns: ["a", "b"],
      rows: [
        ["1", "x"],
        ["2", "y"],
      ],
    });
    expect(mimeType).toBe("text/csv");
    expect(ext).toBe("csv");
    const text = buffer.toString("utf-8");
    expect(text.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(text).toBe("﻿a,b\r\n1,x\r\n2,y\r\n");
  });

  it("quotes and escapes fields containing comma, quote, or newline", () => {
    const { buffer } = generateFile({
      format: "csv",
      columns: ["c"],
      rows: [["a,b"], ['he said "hi"'], ["line1\nline2"]],
    });
    const text = buffer.toString("utf-8").replace(/^﻿/, "");
    expect(text).toBe('c\r\n"a,b"\r\n"he said ""hi"""\r\n"line1\nline2"\r\n');
  });

  it("serializes numbers and booleans without quoting", () => {
    const { buffer } = generateFile({
      format: "csv",
      columns: ["n", "b"],
      rows: [[1200.5, true]],
    });
    const text = buffer.toString("utf-8").replace(/^﻿/, "");
    expect(text).toBe("n,b\r\n1200.5,true\r\n");
  });
});
