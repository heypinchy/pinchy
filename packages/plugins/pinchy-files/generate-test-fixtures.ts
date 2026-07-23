/**
 * Generate PDF test fixtures for pinchy-files plugin tests.
 *
 * Run with: npx tsx generate-test-fixtures.ts
 *
 * Creates:
 *   test-fixtures/text-only.pdf          — 3-page plain text
 *   test-fixtures/with-tables.pdf        — table with 4 columns, 5+ rows
 *   test-fixtures/scanned.pdf            — image-only (no text layer)
 *   test-fixtures/mixed.pdf              — pages 1-2 text, page 3 image-only
 *   test-fixtures/with-images.pdf        — text + embedded PNG images
 *   test-fixtures/large-60pages.pdf      — 60-page stress test
 *   test-fixtures/password-protected.pdf — encrypted PDF (password: testpass123)
 *   test-fixtures/corrupted.pdf          — truncated/broken PDF
 *
 * Authoring uses pdfkit (the repo's runtime PDF library); pdf-lib is no longer
 * a dependency of this plugin. Image fixtures are rasterized with @napi-rs/canvas.
 */

import PDFDocument from "pdfkit";
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const FIXTURES_DIR = join(import.meta.dirname!, "test-fixtures");
mkdirSync(FIXTURES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const HEADING_SIZE = 18;
const BODY_SIZE = 11;

/** Collect a pdfkit document into a Buffer. */
function buildPdf(
  build: (doc: PDFKit.PDFDocument) => void,
  options: PDFKit.PDFDocumentOptions = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: MARGIN, ...options });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

/**
 * Write a sequence of heading/body paragraphs using pdfkit's automatic text
 * flow (wrapping + page breaks are handled by pdfkit). `font`/`bold` are
 * pdfkit built-in font names, e.g. "Times-Roman"/"Times-Bold".
 */
function writeParagraphs(
  doc: PDFKit.PDFDocument,
  font: string,
  bold: string,
  paragraphs: { text: string; heading?: boolean }[]
): void {
  for (const para of paragraphs) {
    if (para.heading) {
      doc.font(bold).fontSize(HEADING_SIZE).fillColor("black").text(para.text);
      doc.moveDown(0.5);
    } else {
      doc.font(font).fontSize(BODY_SIZE).fillColor("black").text(para.text);
      doc.moveDown(0.5);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. text-only.pdf — 3 pages of plain text
// ---------------------------------------------------------------------------

function createTextOnly(): Promise<Buffer> {
  return buildPdf((doc) => {
    // Page 1 — Executive Summary
    writeParagraphs(doc, "Times-Roman", "Times-Bold", [
      { text: "Acme Corp Annual Report 2025", heading: true },
      { text: "Executive Summary", heading: true },
      {
        text: "Acme Corp is pleased to present its annual report for fiscal year 2025. This year marked a significant milestone in our company history as we expanded operations into three new markets across Europe and Southeast Asia. Our total revenue reached $847 million, representing a 23% increase compared to the previous fiscal year.",
      },
      {
        text: "The board of directors approved a strategic investment plan totaling $120 million over the next three years. This investment will focus on research and development of sustainable manufacturing processes, digital transformation initiatives, and workforce development programs.",
      },
      {
        text: "Our commitment to innovation has yielded impressive results. The research division filed 47 new patents during the fiscal year, bringing our total patent portfolio to over 300 active patents worldwide. Key innovations include our proprietary SmartWidget technology and the EcoProcess manufacturing method.",
      },
      { text: "Financial Highlights", heading: true },
      {
        text: "Total revenue for fiscal year 2025 was $847 million, with net income of $112 million. Operating margins improved to 18.3%, up from 15.7% in the prior year. Earnings per share increased to $4.23 from $3.41, reflecting strong operational performance across all business segments.",
      },
      {
        text: "The company maintained a healthy balance sheet with total assets of $2.1 billion and a debt-to-equity ratio of 0.42. Cash and equivalents stood at $234 million at year end, providing substantial flexibility for future investments and acquisitions.",
      },
    ]);

    // Page 2 — Operations Review
    doc.addPage();
    writeParagraphs(doc, "Times-Roman", "Times-Bold", [
      { text: "Operations Review", heading: true },
      { text: "Manufacturing Division", heading: true },
      {
        text: "The manufacturing division delivered record output of 12.4 million units across our product portfolio. Our flagship Springfield facility completed a major upgrade to automated production lines, increasing throughput by 35% while reducing energy consumption by 22%. Quality metrics improved with defect rates falling below 0.3% for the first time.",
      },
      {
        text: "Supply chain resilience remained a priority throughout the year. We diversified our supplier base to include 15 new qualified vendors and implemented real-time inventory tracking across all warehouses. These improvements reduced average lead times from 21 days to 14 days.",
      },
      { text: "Technology and Innovation", heading: true },
      {
        text: "Our technology team launched the Acme CloudConnect platform, enabling customers to monitor and manage their Acme products remotely. Within six months of launch, over 40,000 customers had adopted the platform, generating $12 million in recurring subscription revenue.",
      },
      {
        text: "The artificial intelligence research group made breakthrough progress on predictive maintenance algorithms. Field trials demonstrated a 60% reduction in unplanned equipment downtime for customers using our AI-powered monitoring solutions.",
      },
    ]);

    // Page 3 — Outlook
    doc.addPage();
    writeParagraphs(doc, "Times-Roman", "Times-Bold", [
      { text: "Future Outlook", heading: true },
      { text: "Strategic Priorities for 2026", heading: true },
      {
        text: "Looking ahead to fiscal year 2026, Acme Corp will focus on three strategic priorities. First, we will accelerate our digital transformation roadmap with a planned investment of $45 million in cloud infrastructure and data analytics capabilities.",
      },
      {
        text: "Second, our expansion into the renewable energy components market is expected to generate $80 million in new revenue by the end of 2026. We have already secured letters of intent from major solar panel manufacturers and wind turbine producers.",
      },
      {
        text: "Third, we will continue to invest in our people. The Acme Academy program will expand to offer over 200 courses in technical skills, leadership development, and sustainability practices. We aim to provide at least 40 hours of professional development per employee annually.",
      },
      { text: "Sustainability Commitment", heading: true },
      {
        text: "Acme Corp remains committed to achieving carbon neutrality by 2030. During fiscal year 2025, we reduced our Scope 1 and 2 emissions by 18% compared to our 2020 baseline. We installed 5 megawatts of solar capacity at our manufacturing facilities and transitioned 40% of our vehicle fleet to electric vehicles.",
      },
      {
        text: "In conclusion, Acme Corp enters 2026 from a position of strength. Our diversified business model, strong balance sheet, and talented workforce position us well to capitalize on emerging opportunities while delivering sustainable value to our shareholders and communities.",
      },
    ]);
  });
}

// ---------------------------------------------------------------------------
// 2. with-tables.pdf — PDF with a table
// ---------------------------------------------------------------------------

function createWithTables(): Promise<Buffer> {
  return buildPdf((doc) => {
    // Title
    doc
      .font("Helvetica-Bold")
      .fontSize(16)
      .fillColor("black")
      .text("Acme Corp — Engineering Department Roster", MARGIN, MARGIN);

    // Table config
    const colWidths = [120, 100, 170, 120];
    const headers = ["Name", "Role", "Email", "Department"];
    const rows = [
      ["John Smith", "Lead Engineer", "john.smith@acme.com", "Engineering"],
      ["Jane Doe", "Senior Developer", "jane.doe@acme.com", "Engineering"],
      ["Robert Chen", "DevOps Manager", "robert.chen@acme.com", "Operations"],
      ["Maria Garcia", "Data Scientist", "maria.garcia@acme.com", "Analytics"],
      ["Ahmed Hassan", "QA Lead", "ahmed.hassan@acme.com", "Quality"],
      ["Lisa Wang", "Product Manager", "lisa.wang@acme.com", "Product"],
      ["James Wilson", "Security Analyst", "james.wilson@acme.com", "Security"],
    ];

    const tableTop = MARGIN + 40;
    const rowHeight = 24;
    const totalWidth = colWidths.reduce((a, b) => a + b, 0);

    // Header background
    doc.rect(MARGIN, tableTop, totalWidth, rowHeight).fill("#d9d9d9");

    // Header text
    doc.fillColor("black").font("Helvetica-Bold").fontSize(10);
    let x = MARGIN;
    for (let c = 0; c < headers.length; c++) {
      doc.text(headers[c], x + 5, tableTop + 7, { width: colWidths[c] - 6, lineBreak: false });
      x += colWidths[c];
    }

    // Data rows
    doc.font("Helvetica").fontSize(10);
    let y = tableTop + rowHeight;
    for (const row of rows) {
      x = MARGIN;
      for (let c = 0; c < row.length; c++) {
        doc.text(row[c], x + 5, y + 7, { width: colWidths[c] - 6, lineBreak: false });
        x += colWidths[c];
      }
      y += rowHeight;
    }

    // Grid lines
    const tableBottom = tableTop + (rows.length + 1) * rowHeight;
    doc.strokeColor("black").lineWidth(0.5);
    for (let r = 0; r <= rows.length + 1; r++) {
      const gy = tableTop + r * rowHeight;
      doc
        .moveTo(MARGIN, gy)
        .lineTo(MARGIN + totalWidth, gy)
        .stroke();
    }
    let vx = MARGIN;
    for (let c = 0; c <= colWidths.length; c++) {
      doc.moveTo(vx, tableTop).lineTo(vx, tableBottom).stroke();
      if (c < colWidths.length) vx += colWidths[c];
    }

    // Footer text below table
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("black")
      .text("Total employees listed: 7", MARGIN, tableBottom + 16, { lineBreak: false });
    doc
      .fillColor("#666666")
      .text("Last updated: January 15, 2025", MARGIN, tableBottom + 32, { lineBreak: false });
  });
}

// ---------------------------------------------------------------------------
// 3. scanned.pdf — image-only, no text layer
// ---------------------------------------------------------------------------

function renderTextToImage(textLines: string[], width = 1200, height = 1600): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // White background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // Render text as pixels
  ctx.fillStyle = "#000000";
  ctx.font = "24px serif";
  let y = 60;
  for (const line of textLines) {
    ctx.fillText(line, 50, y);
    y += 32;
  }

  return canvas.toBuffer("image/png");
}

function createScanned(): Promise<Buffer> {
  const textLines = [
    "CONFIDENTIAL MEMORANDUM",
    "",
    "To: All Department Heads",
    "From: Executive Office",
    "Date: March 15, 2025",
    "Subject: Quarterly Business Review",
    "",
    "This document contains the results of our Q1 2025",
    "performance review. All figures are preliminary and",
    "subject to final audit confirmation.",
    "",
    "Revenue targets were exceeded by 12% across all",
    "regions. The Asia-Pacific division showed the strongest",
    "growth at 28% year-over-year.",
    "",
    "Action items for Q2:",
    "1. Complete hiring for the new Berlin office",
    "2. Finalize vendor contracts for Project Aurora",
    "3. Submit regulatory filings by April 30th",
    "",
    "Please treat this information as strictly confidential",
    "until the official announcement on April 5th.",
  ];

  const imgBuf = renderTextToImage(textLines);
  return buildPdf((doc) => {
    doc.image(imgBuf, 0, 0, { width: PAGE_WIDTH, height: PAGE_HEIGHT });
  });
}

// ---------------------------------------------------------------------------
// 4. mixed.pdf — 2 text pages + 1 image-only page
// ---------------------------------------------------------------------------

function createMixed(): Promise<Buffer> {
  const scanLines = [
    "DRAFT - Internal Use Only",
    "",
    "Roadmap Notes - Q3 2025",
    "",
    "- Plugin marketplace beta launch",
    "- Cross-channel workflow engine",
    "- Advanced RBAC with team scoping",
    "- SSO integration (SAML, OIDC)",
    "",
    "These items are subject to change.",
  ];
  const imgBuf = renderTextToImage(scanLines);

  return buildPdf((doc) => {
    // Page 1 — text
    writeParagraphs(doc, "Times-Roman", "Times-Bold", [
      { text: "Pinchy Platform Overview", heading: true },
      {
        text: "Pinchy is an enterprise AI agent platform designed for organizations that need to run autonomous AI agents with proper governance and control. Built on top of the OpenClaw runtime, Pinchy adds the enterprise layer that businesses require.",
      },
      {
        text: "Key features include role-based access control, comprehensive audit trails, and a plugin architecture that allows administrators to precisely control what each agent can and cannot do. Every action is logged and traceable.",
      },
      { text: "Architecture", heading: true },
      {
        text: "The platform uses a layered architecture where OpenClaw provides the agent runtime capabilities while Pinchy wraps these with permission checks, user management, and audit logging. This separation ensures that Pinchy benefits from OpenClaw improvements without forking the runtime.",
      },
    ]);

    // Page 2 — text
    doc.addPage();
    writeParagraphs(doc, "Times-Roman", "Times-Bold", [
      { text: "Deployment Guide", heading: true },
      {
        text: "Pinchy is deployed using Docker Compose, which orchestrates all required services including the web application, PostgreSQL database, and OpenClaw runtime. A single docker compose up command brings the entire stack online.",
      },
      {
        text: "The self-hosted deployment model ensures that all data remains within the organization network. No external API calls are required when using local models through Ollama integration. This makes Pinchy suitable for air-gapped environments.",
      },
    ]);

    // Page 3 — image only (scanned)
    doc.addPage();
    doc.image(imgBuf, 0, 0, { width: PAGE_WIDTH, height: PAGE_HEIGHT });
  });
}

// ---------------------------------------------------------------------------
// 5. with-images.pdf — text + embedded PNG images
// ---------------------------------------------------------------------------

function makeLabeledImage(color: string, label: string): Buffer {
  const canvas = createCanvas(200, 150);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 200, 150);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 20px sans-serif";
  ctx.fillText(label, 50, 80);
  return canvas.toBuffer("image/png");
}

function createWithImages(): Promise<Buffer> {
  const img1 = makeLabeledImage("#2563eb", "Widget A");
  const img2 = makeLabeledImage("#16a34a", "Widget B");

  return buildPdf((doc) => {
    writeParagraphs(doc, "Helvetica", "Helvetica-Bold", [
      { text: "Product Catalog — Spring 2025", heading: true },
      {
        text: "Below you will find our featured products for the spring season. Each product image shows the item in its standard configuration. Custom colors and sizes are available upon request.",
      },
    ]);

    let y = doc.y + 10;
    doc.image(img1, MARGIN, y, { width: 200, height: 150 });
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("black")
      .text("Widget A — Industrial Grade Fastener", MARGIN + 220, y + 40);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#4d4d4d")
      .text("Price: $24.99 | SKU: WA-2025-001", MARGIN + 220, y + 58);

    y += 180;
    doc.image(img2, MARGIN, y, { width: 200, height: 150 });
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("black")
      .text("Widget B — Precision Component", MARGIN + 220, y + 40);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#4d4d4d")
      .text("Price: $37.50 | SKU: WB-2025-002", MARGIN + 220, y + 58);
  });
}

// ---------------------------------------------------------------------------
// 6. large-60pages.pdf — 60 pages for stress testing
// ---------------------------------------------------------------------------

function createLarge60(): Promise<Buffer> {
  return buildPdf((doc) => {
    for (let i = 1; i <= 60; i++) {
      if (i > 1) doc.addPage();
      writeParagraphs(doc, "Courier", "Courier-Bold", [
        { text: `Page ${i} of 60`, heading: true },
        {
          text: `This is page number ${i} of the large test document. It contains placeholder text to simulate a realistic multi-page PDF that might be encountered in enterprise environments.`,
        },
        {
          text: `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`,
        },
        {
          text: `Section ${i}.1: Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.`,
        },
        {
          text: `Section ${i}.2: Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris.`,
        },
      ]);
    }
  });
}

// ---------------------------------------------------------------------------
// 7. password-protected.pdf — encrypted with qpdf
// ---------------------------------------------------------------------------

async function createPasswordProtected(): Promise<Buffer> {
  const pdfBytes = await buildPdf((doc) => {
    doc
      .font("Helvetica")
      .fontSize(14)
      .fillColor("black")
      .text("This document is password protected.", MARGIN, MARGIN);
    doc.fontSize(12).text("The password is testpass123.", MARGIN, MARGIN + 30);
  });

  // Encrypt with qpdf (AES-256).
  try {
    const tmpIn = join(FIXTURES_DIR, "_tmp_unencrypted.pdf");
    const tmpOut = join(FIXTURES_DIR, "password-protected.pdf");
    writeFileSync(tmpIn, pdfBytes);
    execSync(`qpdf --encrypt testpass123 testpass123 256 -- "${tmpIn}" "${tmpOut}"`, {
      stdio: "pipe",
    });
    unlinkSync(tmpIn);
    return readFileSync(tmpOut);
  } catch {
    throw new Error(
      "qpdf is required to generate password-protected.pdf. Install it via: brew install qpdf (macOS) or apt-get install qpdf (Linux)"
    );
  }
}

// ---------------------------------------------------------------------------
// 8. corrupted.pdf — truncated PDF
// ---------------------------------------------------------------------------

function createCorrupted(sourcePdf: Buffer): Buffer {
  // Take the first 50% of bytes
  const halfLength = Math.floor(sourcePdf.length / 2);
  return sourcePdf.subarray(0, halfLength);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Generating PDF test fixtures...\n");

  // 1. text-only.pdf
  const textOnly = await createTextOnly();
  writeFileSync(join(FIXTURES_DIR, "text-only.pdf"), textOnly);
  console.log(`  text-only.pdf          — ${textOnly.length.toLocaleString()} bytes`);

  // 2. with-tables.pdf
  const withTables = await createWithTables();
  writeFileSync(join(FIXTURES_DIR, "with-tables.pdf"), withTables);
  console.log(`  with-tables.pdf        — ${withTables.length.toLocaleString()} bytes`);

  // 3. scanned.pdf
  const scanned = await createScanned();
  writeFileSync(join(FIXTURES_DIR, "scanned.pdf"), scanned);
  console.log(`  scanned.pdf            — ${scanned.length.toLocaleString()} bytes`);

  // 4. mixed.pdf
  const mixed = await createMixed();
  writeFileSync(join(FIXTURES_DIR, "mixed.pdf"), mixed);
  console.log(`  mixed.pdf              — ${mixed.length.toLocaleString()} bytes`);

  // 5. with-images.pdf
  const withImages = await createWithImages();
  writeFileSync(join(FIXTURES_DIR, "with-images.pdf"), withImages);
  console.log(`  with-images.pdf        — ${withImages.length.toLocaleString()} bytes`);

  // 6. large-60pages.pdf
  const large = await createLarge60();
  writeFileSync(join(FIXTURES_DIR, "large-60pages.pdf"), large);
  console.log(`  large-60pages.pdf      — ${large.length.toLocaleString()} bytes`);

  // 7. password-protected.pdf
  const pwProtected = await createPasswordProtected();
  writeFileSync(join(FIXTURES_DIR, "password-protected.pdf"), pwProtected);
  console.log(`  password-protected.pdf — ${pwProtected.length.toLocaleString()} bytes`);

  // 8. corrupted.pdf (based on text-only.pdf)
  const corrupted = createCorrupted(textOnly);
  writeFileSync(join(FIXTURES_DIR, "corrupted.pdf"), corrupted);
  console.log(`  corrupted.pdf          — ${corrupted.length.toLocaleString()} bytes`);

  console.log("\nDone! All fixtures written to test-fixtures/");
}

main().catch((err) => {
  console.error("Failed to generate fixtures:", err);
  process.exit(1);
});
