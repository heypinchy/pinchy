---
title: "Reading Files and PDFs"
description: "Supported file types, PDF text extraction behavior, truncation on large PDFs, and scanned PDF limitations."
---

## Supported File Types

- **PDFs** (`.pdf`): Full text extraction pipeline. Returns structured XML-like output with page content.
- **Text files** (`.md`, `.txt`, `.csv`, `.json`, `.yaml`, `.html`, etc.): Returned as-is, plain text.
- **Other formats** (`.docx`, `.xlsx`, `.pptx`, `.png`, `.jpg`, etc.): **Not supported.** `pinchy_read` returns raw binary data that appears as garbled text. Always check the file extension before reading — if unsupported, inform the user instead of reading the file.

## PDF Output Format

PDF content is wrapped in an XML-like structure: `<document><source>...</source><pages>N</pages><document_content>...</document_content></document>`.

## PDF Truncation

Large PDFs are capped at **50 pages**. When truncated, the output includes `<note>Document truncated: showing first 50 of N pages.</note>`. Always check for this note — you may be missing content from later pages. If the needed information is beyond page 50, tell the user and ask for a targeted excerpt.

## Scanned PDFs

PDFs that consist entirely of scanned images require vision AI for text extraction. When vision is unavailable or fails, pages return `[Unable to extract text from this scanned page.]`. This is not a query error — the PDF is a scan and OCR is not available. Inform the user and ask for a text version.

## Embedded Images in PDFs

In text-based PDFs, embedded images appear inline as `[Figure: description]` (when vision is available). They do not show up as separate files in `pinchy_ls`.

## Size Limits

Text files over **10 MB** and PDFs over **50 MB** are rejected with a "File too large" error. Ask the user to split the file or provide a specific section.

## Caching

PDFs are cached after the first read. Subsequent reads of the same unchanged file return instantly. No special handling needed.
