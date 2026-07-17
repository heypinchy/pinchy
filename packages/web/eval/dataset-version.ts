/**
 * Semantic version of the published Eval-v1 dataset (pinchy#669, #802).
 *
 * Bump this in the SAME commit that changes what the dataset says — a re-grade
 * that flips outcomes, a model added, a scenario re-run — and record the change
 * in `data/CHANGELOG.md`. The `eval/__tests__/dataset-version.test.ts` guard
 * fails CI if this constant and the CHANGELOG's newest entry disagree, so a
 * silent data change can't ship. Old versions stay published and citable; this
 * names the current one.
 *
 * MAJOR: incompatible dataset shape or a re-grade that moves published numbers.
 * MINOR: additive — new models, new scenarios, new fields.
 * PATCH: corrections that don't move a published number (docs, metadata).
 */
export const DATASET_VERSION = "1.0.0";
