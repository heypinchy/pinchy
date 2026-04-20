---
title: "Navigating the File System"
description: "How pinchy_ls works (non-recursive, one level at a time), path rules, and the correct workflow for finding and reading files."
---

## pinchy_ls is Non-Recursive

`pinchy_ls` lists only the **immediate children** of the given directory — not subdirectories. To explore a nested structure, call it once per level.

Example: `pinchy_ls("/data/kb/")` shows `sales/`, `support/`, `readme.md`. Then `pinchy_ls("/data/kb/sales/")` shows `q1-report.pdf`, `templates/`. Drill down one level at a time.

## Path Rules

- **Always use absolute paths.** Paths must start with the configured base path (e.g. `/data/`). Relative paths like `../docs/` fail with an access-denied error.
- **Path containment**: Any path that starts with a configured `allowed_path` is accessible, including all subdirectories. Paths outside those roots return "Access denied".

## Blocked Entries

- **Hidden files and directories** (names starting with `.`) are blocked by design — `.env`, `.git`, `.DS_Store` will never appear.
- **Office lock files** (e.g. `~$document.docx`) are filtered out — these are temporary files created by Word/Excel while a document is open.

## Common Mistakes

- **Calling `pinchy_ls` on a file path** returns an error. `pinchy_ls` is for directories only. Use `pinchy_read` for file contents.
- **Assuming a path exists** without checking first leads to "not found" errors from typos.

## Recommended Workflow

1. Call `pinchy_ls` on the top-level allowed path to see what is available.
2. Drill into subdirectories with further `pinchy_ls` calls as needed.
3. Once you have the exact path, call `pinchy_read`.

This prevents path typos and ensures you work with the real file structure.
