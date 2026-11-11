import { getTableColumns, type Table } from "drizzle-orm";

/**
 * The most bind parameters one statement may carry. postgres.js refuses a
 * query at 65,534 (`MAX_PARAMETERS_EXCEEDED`, before anything reaches the
 * server), so a multi-row INSERT has to be cut below that.
 */
export const MAX_BIND_PARAMETERS = 65_533;

/**
 * How many rows of `table` one INSERT can take without crossing
 * `MAX_BIND_PARAMETERS`. Derived from the table's columns rather than written
 * down, so a column added later shrinks the batch instead of silently pushing
 * it over the limit. Counting every column is the worst case: a column a row
 * leaves out is sent as `default`, which binds nothing.
 */
export function rowsPerInsert(table: Table): number {
  return Math.floor(MAX_BIND_PARAMETERS / Object.keys(getTableColumns(table)).length);
}

/** `rows` as consecutive slices of at most `size`. */
export function inBatches<T>(rows: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`batch size must be a positive integer, got ${size}`);
  }
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += size) batches.push(rows.slice(i, i + size));
  return batches;
}
