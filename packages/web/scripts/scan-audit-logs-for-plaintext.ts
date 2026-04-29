#!/usr/bin/env tsx
import { db } from "../src/db";
import { auditLog } from "../src/db/schema";
import { findPlaintextSecrets } from "../src/lib/openclaw-plaintext-scanner";

(async () => {
  const rows = await db.select().from(auditLog);
  let hits = 0;
  for (const row of rows) {
    const findings = findPlaintextSecrets(row.detail);
    if (findings.length > 0) {
      console.error(
        `row ${row.id} (${row.eventType}): ${findings.map((f) => f.pattern).join(", ")}`
      );
      hits++;
    }
  }
  console.log(`scanned ${rows.length} rows, ${hits} hits`);
  process.exit(hits > 0 ? 1 : 0);
})();
