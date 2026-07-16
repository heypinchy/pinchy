/**
 * Pure retrieval-quality metrics for the KB eval harness's Layer-1 gate
 * (`packages/web/src/lib/eval/kb`). Each function scores a single query's
 * `retrieved` chunk-id ranking against its gold `relevant` chunk-id set —
 * no I/O, no averaging. Averaging per-query scores into a scorecard (e.g.
 * mean recall@k, MRR) is the runner's job, not this module's.
 *
 * `k` is clamped to `[0, retrieved.length]` throughout: `k <= 0` scores an
 * empty top slice (0 hits), and `k` larger than the array is treated as the
 * array length — neither throws.
 */

/**
 * Fraction of `relevant` ids present in the top-`k` of `retrieved`.
 *
 * Vacuous case: an empty `relevant` set returns 1 rather than 0/0 — the gold
 * set is authored to always have at least one relevant chunk per query, so
 * this only matters for degenerate test inputs, but "nothing was missed"
 * is the more honest reading than "everything was missed."
 */
export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1;
  const top = new Set(retrieved.slice(0, Math.max(0, k)));
  const hit = relevant.filter((id) => top.has(id)).length;
  return hit / relevant.length;
}

/**
 * Reciprocal rank of the first relevant id in `retrieved`: `1/(rank)`
 * (1-indexed), or 0 if no relevant id appears anywhere in the list. This is
 * the single-query RR; mean over queries (MRR) is computed by the runner.
 */
export function reciprocalRank(retrieved: string[], relevant: string[]): number {
  const relevantSet = new Set(relevant);
  const index = retrieved.findIndex((id) => relevantSet.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * Binary-gain nDCG at `k`: relevance is 1 (in `relevant`) or 0, so
 * `DCG = Σ rel_i / log2(i+2)` for the top-`k` (0-indexed position `i`,
 * `+2` because rank 1 sits at `log2(2) = 1`, giving the top slot a
 * discount of exactly 1 rather than the undefined `log2(1+1)=1`... i.e.
 * the `+2` shift avoids `log2(1) = 0` — a rank-1 divisor of zero).
 * `IDCG` is the DCG of the best-possible ranking: `min(|relevant|, k)`
 * hits placed first. `nDCG = DCG/IDCG`, and 0 when `IDCG` is 0 (no
 * relevant ids, or `k <= 0`) rather than dividing by zero.
 */
export function ndcgAtK(retrieved: string[], relevant: string[], k: number): number {
  const kClamped = Math.max(0, k);
  const relevantSet = new Set(relevant);
  const top = retrieved.slice(0, kClamped);

  const dcg = top.reduce((sum, id, i) => sum + (relevantSet.has(id) ? 1 : 0) / Math.log2(i + 2), 0);

  const idealHits = Math.min(relevant.length, kClamped);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}
