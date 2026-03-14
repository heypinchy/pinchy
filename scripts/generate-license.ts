import * as jose from "jose";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "generate-keypair": { type: "boolean", default: false },
    org: { type: "string" },
    type: { type: "string" },
    days: { type: "string" },
    "private-key-file": { type: "string" },
  },
});

async function generateKeypair() {
  const { publicKey, privateKey } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });
  const pubPem = await jose.exportSPKI(publicKey);
  const privPem = await jose.exportPKCS8(privateKey);
  console.error("=== PUBLIC KEY (embed in source code) ===");
  console.log(pubPem);
  console.error("\n=== PRIVATE KEY (keep secret!) ===");
  console.error(privPem);
}

async function generateLicense() {
  const { org, type, days } = values;
  if (!org) {
    console.error("Error: --org is required");
    process.exit(1);
  }
  if (!type || !["trial", "paid"].includes(type)) {
    console.error("Error: --type must be 'trial' or 'paid'");
    process.exit(1);
  }
  const numDays = parseInt(days ?? "0", 10);
  if (!numDays || numDays <= 0) {
    console.error("Error: --days must be a positive number");
    process.exit(1);
  }
  if (type === "trial" && numDays > 14) {
    console.error("Error: trial keys cannot exceed 14 days");
    process.exit(1);
  }
  if (type === "paid" && numDays < 365) {
    console.error("Error: paid keys must be at least 365 days");
    process.exit(1);
  }

  const keyPath = values["private-key-file"];
  if (!keyPath && !process.env.PINCHY_LICENSE_PRIVATE_KEY) {
    console.error(
      "Error: provide --private-key-file or set PINCHY_LICENSE_PRIVATE_KEY env var"
    );
    process.exit(1);
  }

  let privateKeyPem: string;
  if (keyPath) {
    const { readFileSync } = await import("node:fs");
    privateKeyPem = readFileSync(keyPath, "utf-8");
  } else {
    privateKeyPem = process.env.PINCHY_LICENSE_PRIVATE_KEY!;
  }

  let privateKey;
  try {
    privateKey = await jose.importPKCS8(privateKeyPem, "ES256");
  } catch {
    console.error(
      "Error: could not parse private key. Ensure it is a valid PKCS8 PEM for ES256."
    );
    process.exit(1);
  }

  const jwt = await new jose.SignJWT({
    type,
    features: ["enterprise"],
  })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("heypinchy.com")
    .setSubject(org)
    .setIssuedAt()
    .setExpirationTime(`${numDays}d`)
    .sign(privateKey);

  const expDate = new Date(Date.now() + numDays * 86400000);
  console.error(`\nLicense generated:`);
  console.error(`  Org:     ${org}`);
  console.error(`  Type:    ${type}`);
  console.error(`  Expires: ${expDate.toISOString().split("T")[0]} (${numDays} days)`);
  console.error(`\nToken:`);

  console.log(jwt);
}

if (values["generate-keypair"]) {
  generateKeypair();
} else {
  generateLicense();
}
