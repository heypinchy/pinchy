/**
 * Generate .docx test fixtures for pinchy-files plugin tests.
 *
 * Run with: npx tsx generate-docx-fixtures.ts
 *
 * Creates:
 *   test-fixtures/simple.docx     — heading + paragraphs + 2x3 table + inline bold
 *   test-fixtures/with-image.docx — two paragraphs surrounding an embedded PNG image
 */

import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  Table,
  TableRow,
  TableCell,
  ImageRun,
} from "docx";

// Minimal 1×1 px red PNG (base64). This byte array is a valid PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==",
  "base64",
);
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dirname!, "test-fixtures");
mkdirSync(FIXTURES_DIR, { recursive: true });

async function createSimpleDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun("Customer Briefing")],
          }),
          new Paragraph({
            children: [
              new TextRun("ACME Corporation wants a quote for "),
              new TextRun({ text: "20 widgets", bold: true }),
              new TextRun(" delivered by Q3."),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun(
                "The customer prefers blue widgets and has previously ordered from us in 2024.",
              ),
            ],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun("Pricing")],
          }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("SKU")] }),
                  new TableCell({ children: [new Paragraph("Quantity")] }),
                  new TableCell({ children: [new Paragraph("Unit Price")] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("WIDGET-BLUE-01")] }),
                  new TableCell({ children: [new Paragraph("20")] }),
                  new TableCell({ children: [new Paragraph("EUR 42.50")] }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

async function createWithImageDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun("Before image")],
          }),
          new Paragraph({
            children: [
              new ImageRun({
                data: TINY_PNG,
                transformation: { width: 1, height: 1 },
                type: "png",
              }),
            ],
          }),
          new Paragraph({
            children: [new TextRun("After image")],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function main() {
  console.log("Generating .docx test fixtures...\n");

  const simple = await createSimpleDocx();
  writeFileSync(join(FIXTURES_DIR, "simple.docx"), simple);
  console.log(`  simple.docx — ${simple.length.toLocaleString()} bytes`);

  const withImage = await createWithImageDocx();
  writeFileSync(join(FIXTURES_DIR, "with-image.docx"), withImage);
  console.log(`  with-image.docx — ${withImage.length.toLocaleString()} bytes`);

  console.log("\nDone! Fixtures written to test-fixtures/");
}

main().catch((err) => {
  console.error("Failed to generate fixtures:", err);
  process.exit(1);
});
