/**
 * Does every account the screenshot seed creates have an origin Pinchy can
 * explain?
 *
 * `screenshots/seed.sh` runs the setup wizard for the admin and then inserts
 * the rest of the demo team straight into `"user"` — the API has no way to
 * create an already-active account. Since v0.9.2, Settings → Users flags every
 * account neither the setup wizard nor a claimed invite created
 * (`packages/web/src/lib/user-provenance.ts`), and `screenshots/capture.ts`
 * photographs that page as `user-management.png`. A seeded user without a
 * claimed invite would therefore put the "accounts nobody invited" banner into
 * the docs screenshot of a perfectly healthy team, and nothing would go red:
 * the capture succeeds either way.
 *
 * So this reads the seed the way the provenance rule reads the database: every
 * id inserted into `"user"` must be the `claimed_by_user_id` of an invite row
 * of type `invite` with a `claimed_at`. A claimed `reset` invite does not
 * count — it is issued for an account that already exists.
 *
 * It parses SQL `INSERT ... VALUES` tuples with a small paren- and
 * quote-aware splitter rather than regexes over whole rows: the seed's tuples
 * contain sub-selects (`(SELECT id FROM "user" WHERE email = '...')`), and a
 * regex that stops at the first `)` would read half a row and still pass.
 */

/** Split `s` on `sep` at paren depth 0, outside single-quoted strings. */
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === "'" && s[i + 1] === "'") i++;
      else if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Return the top-level `( ... )` groups of a VALUES list, without parens. */
function valueTuples(valuesText) {
  const tuples = [];
  let depth = 0;
  let inQuote = false;
  let start = -1;
  for (let i = 0; i < valuesText.length; i++) {
    const ch = valuesText[i];
    if (inQuote) {
      if (ch === "'" && valuesText[i + 1] === "'") i++;
      else if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        tuples.push(valuesText.slice(start, i));
        // The list goes on only past a comma; `ON CONFLICT (email)` and
        // friends come next otherwise, and their parens are not a row.
        const next = valuesText.slice(i + 1).match(/^\s*(.)/s);
        if (!next || next[1] !== ",") break;
      }
    } else if (depth === 0 && /\S/.test(ch) && ch !== ",") {
      break;
    }
  }
  return tuples;
}

/** Escape every regex metacharacter, backslash included, so a table name is matched literally. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/^\s*--.*$/, ""))
    .join("\n");
}

/**
 * Every `INSERT INTO <table> (cols) VALUES ...` in `sql`, as rows of
 * column → raw SQL expression.
 */
export function parseInserts(sql, table) {
  const clean = stripSqlComments(sql);
  const header = new RegExp(
    `INSERT\\s+INTO\\s+${escapeRegExp(table)}\\s*\\(([^)]*)\\)\\s*VALUES`,
    "gi",
  );
  const rows = [];
  let m;
  while ((m = header.exec(clean)) !== null) {
    const columns = m[1].split(",").map((c) => c.trim().replace(/"/g, ""));
    const rest = clean.slice(header.lastIndex);
    for (const tuple of valueTuples(rest)) {
      const values = splitTopLevel(tuple, ",");
      if (values.length !== columns.length) {
        throw new Error(
          `INSERT INTO ${table}: ${columns.length} columns but ${values.length} values in (${tuple.trim()})`,
        );
      }
      rows.push(Object.fromEntries(columns.map((c, i) => [c, values[i]])));
    }
  }
  return rows;
}

function literal(expr) {
  const m = /^'((?:[^']|'')*)'$/.exec(expr?.trim() ?? "");
  return m ? m[1].replace(/''/g, "'") : null;
}

/** Ids inserted into `"user"` that no claimed `invite`-type invite accounts for. */
export function findUnexplainedSeedUsers(seedText) {
  const users = parseInserts(seedText, '"user"');
  if (users.length === 0) return { users: [], unexplained: [] };

  const claimers = new Set(
    parseInserts(seedText, "invites")
      .filter(
        (r) =>
          literal(r.type) === "invite" &&
          r.claimed_at !== undefined &&
          r.claimed_at.toUpperCase() !== "NULL",
      )
      .map((r) => literal(r.claimed_by_user_id))
      .filter(Boolean),
  );

  const ids = users.map((u) => {
    const id = literal(u.id);
    if (!id) throw new Error(`seeded user without a literal id: ${u.id}`);
    return id;
  });
  return { users: ids, unexplained: ids.filter((id) => !claimers.has(id)) };
}
