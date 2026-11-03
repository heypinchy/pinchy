// Says what Pinchy will sign and encrypt with when it starts, without
// starting it or touching the database. Read-only, and never prints a key.
// Exits 1 when something needs fixing first. See
// docs/src/content/docs/concepts/audit-trail-verification.mdx.
import { runKeyCheck } from "../src/lib/key-check";

const report = runKeyCheck();
console.log(report.text);
process.exit(report.needsAction ? 1 : 0);
