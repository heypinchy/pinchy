/**
 * A citation is only useful if the reader recognises the path in it. We index
 * from a container mount and store `/data/…`, which nobody at the customer has
 * ever seen — they know the tree below it from Explorer. #933.
 *
 * The pair is a BIJECTION on purpose, and that is the load-bearing property
 * here rather than a nicety: the citation shown to the model is also the string
 * `source-links.ts` linkifies, and the link has to resolve back to the exact
 * file the retrieval returned. A lossy prettifier would hand the reader a
 * citation they recognise attached to a link that opens nothing.
 */
import { describe, it, expect } from "vitest";

import { toCitationPath, fromCitationPath, DATA_ROOT } from "@/lib/knowledge/citation-path";

const CORPUS = [
  "/data/noack/OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf",
  "/data/handbook-2011/policy.md",
  "/data/kb/2011/spec.pdf",
  "/data/kb/2012/spec.pdf",
  "/data/report.pdf",
];

describe("toCitationPath", () => {
  it("drops the data root so the citation reads as the customer's own tree", () => {
    expect(toCitationPath("/data/noack/OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf")).toBe(
      "noack/OLD/QF_2012/PrintingFiles_QF/PI_EColi.pdf"
    );
  });

  it("keeps same-named documents in different folders distinguishable", () => {
    expect(toCitationPath("/data/kb/2011/spec.pdf")).toBe("kb/2011/spec.pdf");
    expect(toCitationPath("/data/kb/2012/spec.pdf")).toBe("kb/2012/spec.pdf");
  });

  it("keeps the mount name, because two mounts can hold the same tree", () => {
    // Stripping the mount as well would read marginally closer to Explorer and
    // cost two things that matter more: `hr/policy.pdf` and `eng/policy.pdf`
    // would collapse into one indistinguishable citation, and the mapping would
    // stop being invertible — see fromCitationPath.
    expect(toCitationPath("/data/hr/policy.pdf")).toBe("hr/policy.pdf");
    expect(toCitationPath("/data/eng/policy.pdf")).toBe("eng/policy.pdf");
  });

  it("leaves a path outside the data root untouched rather than mangling it", () => {
    // Ingest cannot reach outside /data (path-validation.ts), so this is a
    // can't-happen. Returning the input unchanged means an unexpected shape
    // costs readability, never correctness.
    expect(toCitationPath("/srv/elsewhere/report.pdf")).toBe("/srv/elsewhere/report.pdf");
  });

  it("never leaks the absolute container path for any corpus-shaped input", () => {
    for (const absolute of CORPUS) {
      expect(toCitationPath(absolute).startsWith(DATA_ROOT), absolute).toBe(false);
    }
  });
});

describe("fromCitationPath", () => {
  it("round-trips every corpus-shaped path back to the byte-identical original", () => {
    // The property the citation link depends on. If this ever stops holding,
    // a reader gets a citation they recognise and a link that opens nothing.
    for (const absolute of CORPUS) {
      expect(fromCitationPath(toCitationPath(absolute)), absolute).toBe(absolute);
    }
  });

  it("confines a citation path to the data root even when it tries to climb out", () => {
    // The path in a link comes from MODEL output, so it is untrusted. This
    // function only ever produces a /data/-prefixed string; the workspace-file
    // route still resolves and re-checks it against the agent's granted paths,
    // so this is the outer of two gates, not the only one.
    expect(fromCitationPath("../etc/passwd").startsWith(DATA_ROOT)).toBe(true);
    expect(fromCitationPath("/etc/passwd").startsWith(DATA_ROOT)).toBe(true);
  });
});
