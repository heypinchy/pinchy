import { expectTypeOf, test } from "vitest";
import type {
  GoldQA,
  GoldQuery,
  KbEvalAxis,
  KbFailureTag,
  KbGraderResult,
  RetrievedChunk,
  RunResult,
} from "../types";
import type { RunResult as InvoiceRunResult } from "../../types";
import type { KbRunResult } from "../answer-graders";

test("KbGraderResult.tags is exactly KbFailureTag[], not the invoice FailureTag[]", () => {
  expectTypeOf<KbGraderResult["tags"]>().toEqualTypeOf<KbFailureTag[]>();
  expectTypeOf<KbGraderResult["passed"]>().toEqualTypeOf<boolean>();
  expectTypeOf<KbGraderResult["notes"]>().toEqualTypeOf<string[]>();
});

test("RunResult (no type argument, the default) is re-exported unchanged from the shared invoice eval types", () => {
  expectTypeOf<RunResult>().toEqualTypeOf<InvoiceRunResult>();
});

test("RunResult<Tag> is generic over its failure-tag union — KbRunResult is RunResult<KbFailureTag> with no cast", () => {
  expectTypeOf<RunResult<KbFailureTag>["tags"]>().toEqualTypeOf<KbFailureTag[]>();
  expectTypeOf<KbRunResult>().toEqualTypeOf<RunResult<KbFailureTag>>();
  expectTypeOf<KbRunResult["tags"]>().toEqualTypeOf<KbFailureTag[]>();
  // The invoice default is unaffected: RunResult<FailureTag> (explicit) still
  // equals the no-argument default used by the invoice harness.
  expectTypeOf<RunResult<KbFailureTag>>().not.toEqualTypeOf<InvoiceRunResult>();
});

test("GoldQA extends GoldQuery plus an answer key", () => {
  // A concrete GoldQuery-shaped value must be a valid GoldQA once the extra
  // fields are added — this is the actual "extends" contract, not just a
  // structural coincidence checked by toMatchObjectType alone.
  const query: GoldQuery = {
    id: "q1",
    lang: "de",
    query: "Wie lange ist die Kündigungsfrist?",
    relevantChunkIds: ["chunk-1", "chunk-2"],
    axis: "happy",
  };
  const qa: GoldQA = { ...query, referenceAnswer: "Drei Monate zum Quartalsende." };

  expectTypeOf(qa).toExtend<GoldQuery>();
  expectTypeOf<GoldQA["referenceAnswer"]>().toEqualTypeOf<string>();
  expectTypeOf<GoldQA["expectAbstention"]>().toEqualTypeOf<boolean | undefined>();

  // GoldQuery itself must NOT carry the GoldQA-only fields.
  expectTypeOf<GoldQuery>().not.toHaveProperty("referenceAnswer");
});

test("RetrievedChunk field types mirror retrieve()'s return shape", () => {
  expectTypeOf<RetrievedChunk["chunkId"]>().toEqualTypeOf<string>();
  expectTypeOf<RetrievedChunk["sourcePath"]>().toEqualTypeOf<string>();
  expectTypeOf<RetrievedChunk["page"]>().toEqualTypeOf<number | null>();
  expectTypeOf<RetrievedChunk["text"]>().toEqualTypeOf<string>();
  expectTypeOf<RetrievedChunk["score"]>().toEqualTypeOf<number>();
});

test("GoldQuery field types", () => {
  expectTypeOf<GoldQuery["id"]>().toEqualTypeOf<string>();
  expectTypeOf<GoldQuery["lang"]>().toEqualTypeOf<"de" | "en">();
  expectTypeOf<GoldQuery["query"]>().toEqualTypeOf<string>();
  expectTypeOf<GoldQuery["relevantChunkIds"]>().toEqualTypeOf<string[]>();
  expectTypeOf<GoldQuery["axis"]>().toEqualTypeOf<KbEvalAxis>();
});

test("KbEvalAxis is exactly the six behavioral axes", () => {
  expectTypeOf<KbEvalAxis>().toEqualTypeOf<
    "happy" | "path-citation" | "dedup" | "multi-hop" | "distractor" | "cross-lingual"
  >();
});

test("KbFailureTag is exactly the ten KB failure modes", () => {
  expectTypeOf<KbFailureTag>().toEqualTypeOf<
    | "recall-miss"
    | "dedup-inflation"
    | "path-not-cited"
    | "citation-unresolved"
    | "source-uncited"
    | "sources-format"
    | "ungrounded-claim"
    | "off-topic-grounded"
    | "false-abstention"
    | "missed-abstention"
  >();
});
