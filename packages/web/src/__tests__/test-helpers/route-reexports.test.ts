/**
 * `relativeReExports` is how the route guards see through a route file that is
 * nothing but `export { GET } from "../route"` (#1268). Each guard reads route
 * files as text or AST, and a re-export carries none of what they look for — no
 * auth call, no frame header, no handler body — so without this every one of
 * them reads the file as empty and either fails (auth) or waves it through.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "vitest";

import { relativeReExports } from "@/test-helpers/route-reexports";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pinchy-route-reexports-"));
  mkdirSync(join(root, "child"));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- per-test temp dir
  writeFileSync(join(root, "route.ts"), "export const GET = 1;");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("relativeReExports", () => {
  it("resolves a relative re-export to the file it names", () => {
    const file = join(root, "child", "route.ts");

    expect(relativeReExports(file, 'export { GET } from "../route";')).toEqual([
      { target: join(root, "route.ts"), names: [{ local: "GET", exported: "GET" }] },
    ]);
  });

  it("keeps the local and the exported name apart, so `HEAD as GET` is a GET", () => {
    const file = join(root, "child", "route.ts");

    const [reExport] = relativeReExports(file, 'export { HEAD as GET, POST } from "../route";');

    expect(reExport.names).toEqual([
      { local: "HEAD", exported: "GET" },
      { local: "POST", exported: "POST" },
    ]);
  });

  it("finds nothing in a file that declares its own handlers", () => {
    expect(relativeReExports(join(root, "route.ts"), "export async function GET() {}")).toEqual([]);
  });

  it("reads a list carrying comments, and skips type-only names", () => {
    const file = join(root, "child", "route.ts");
    const source =
      'export {\n  // the viewer (#1268)\n  GET /* why */,\n  type Foo,\n} from "../route";';

    expect(relativeReExports(file, source)[0].names).toEqual([{ local: "GET", exported: "GET" }]);
  });

  it("ignores a re-export that only appears in a comment", () => {
    // Treating prose as code would let a route with no auth of its own borrow
    // its sibling's — the "presence of a string" failure.
    const file = join(root, "child", "route.ts");
    const source = '// see `export { GET } from "../route"`\nexport async function GET() {}';

    expect(relativeReExports(file, source)).toEqual([]);
  });

  it("throws on a re-export it cannot follow, rather than reading the file as empty", () => {
    // A guard that silently skipped `export * from` or an aliased specifier would
    // report the route as compliant on the strength of having read nothing.
    const file = join(root, "child", "route.ts");

    expect(() => relativeReExports(file, 'export * from "../route";')).toThrow(/cannot follow/);
    expect(() => relativeReExports(file, 'export { GET } from "@/app/api/x/route";')).toThrow(
      /cannot follow/
    );
    expect(() => relativeReExports(file, 'export { GET } from "../missing";')).toThrow(
      /cannot follow/
    );
  });
});
