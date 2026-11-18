// Pure extraction helpers for the in-app link guard
// (`app-route-link-coverage.test.ts`). Kept in their own module so the parsing
// can be unit-tested against fixtures rather than only against the live tree.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Removes comments while leaving every string and template literal intact.
 *
 * A plain regex over the source reads `router.push("/\t/evil.com")` inside a
 * JSDoc block as a real navigation — `src/lib/return-to.ts` documents that
 * exact attack in prose. This is the same rule the Dockerfile toolchain guard
 * follows: strip the explanation before matching, or the explanation of a link
 * gets reported as the link.
 *
 * Known limitation: a backslash in code position is copied together with the
 * character after it, which is what keeps a regex literal such as
 * `/^https?:\/\//` from being read as the start of a line comment. An
 * unescaped `//` inside a regex would still truncate the line — no such
 * literal exists in this tree, and the failure direction is a missed link
 * rather than a false report.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "\\") {
      out += ch + (next ?? "");
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Every navigable route the App Router serves, as a segment pattern: route
 * groups `(app)` disappear, `[agentId]` becomes `*`, `[...rest]` becomes `**`.
 *
 * `route.ts` counts as well as `page.tsx` — `src/app/share-target/route.ts` is
 * a real destination a link may name, and a page-only reading would report it
 * as broken. `app/api/**` is left out because those are never link targets and
 * ~100 of them would bury the failure message.
 */
export function collectServedRoutes(appDir: string): string[] {
  const routes = walk(appDir)
    .filter((file) => !relative(appDir, file).startsWith(`api${sep}`))
    .filter((file) => /(^|[/\\])(page|route)\.tsx?$/.test(file))
    .map((file) => {
      const segments = relative(appDir, file)
        .split(sep)
        .slice(0, -1)
        .filter((segment) => !/^\(.*\)$/.test(segment))
        .map((segment) => {
          if (/^\[\.\.\..+\]$/.test(segment)) return "**";
          if (/^\[.+\]$/.test(segment)) return "*";
          return segment;
        });
      return "/" + segments.join("/");
    });
  return [...new Set(routes)].sort();
}

export interface LinkReference {
  /** The path with `${…}` collapsed to `*`, query and hash removed. */
  path: string;
  /** Repo-relative file the reference was written in. */
  file: string;
  /** The literal as written, for the failure message. */
  raw: string;
}

/**
 * `href=`, `router.push(`, `router.replace(` and `redirect(` with a literal
 * (or template-literal) target. A computed target is deliberately not
 * reported — guessing what a variable holds is how a guard starts lying.
 */
const LINK_PATTERN =
  /(?:href=|router\.(?:push|replace)\(|\bredirect\()\s*[{(]?\s*(?:`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;

export function extractLinkReferences(source: string, file: string): LinkReference[] {
  const found: LinkReference[] = [];
  const code = stripComments(source);
  let match: RegExpExecArray | null;

  while ((match = LINK_PATTERN.exec(code)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (!raw || !raw.startsWith("/")) continue;
    const path =
      raw
        .split("?")[0]
        .split("#")[0]
        .replace(/\$\{[^}]*\}/g, "*")
        .replace(/\/+$/, "") || "/";
    found.push({ path, file, raw });
  }

  return found;
}

/** Whether a referenced path is served from `public/` rather than by a route. */
export function isPublicAsset(path: string, publicDir: string): boolean {
  const first = path.split("/")[1];
  if (!first || first.includes("*")) return false;
  return existsSync(join(publicDir, first));
}

export function matchesRoute(path: string, routes: string[]): boolean {
  const parts = path.split("/").filter(Boolean);
  return routes.some((route) => {
    const routeParts = route.split("/").filter(Boolean);
    const catchAllAt = routeParts.indexOf("**");
    if (catchAllAt >= 0) {
      if (parts.length < catchAllAt) return false;
      return routeParts
        .slice(0, catchAllAt)
        .every((segment, i) => segment === "*" || segment === parts[i]);
    }
    if (routeParts.length !== parts.length) return false;
    return routeParts.every((segment, i) => segment === "*" || segment === parts[i]);
  });
}

export function collectSourceFiles(srcDir: string): string[] {
  return walk(srcDir).filter(
    (file) => /\.tsx?$/.test(file) && !file.includes(`${sep}__tests__${sep}`)
  );
}
