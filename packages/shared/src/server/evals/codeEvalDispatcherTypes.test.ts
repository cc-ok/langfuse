import { describe, expect, it } from "vitest";
import {
  CODE_EVAL_RUN_TEXT_MAX_LENGTH,
  parseDispatchResult,
  parseRunDispatchResult,
} from "./codeEvalDispatcherTypes";
import { TEXT_SCORE_MAX_LENGTH } from "../../domain/scores";

const textScore = (length: number) => ({
  scores: [{ name: "x", dataType: "TEXT", value: "a".repeat(length) }],
});

/**
 * Scheduled evaluations feed score ingestion, so their TEXT cap must stay at
 * `TEXT_SCORE_MAX_LENGTH`. Ad-hoc runs write no score, so they accept longer
 * text for callers that reuse it outside of ingestion.
 */
describe("code eval result TEXT length", () => {
  it("keeps the ingestion cap for scheduled evaluations", () => {
    expect(() =>
      parseDispatchResult(textScore(TEXT_SCORE_MAX_LENGTH)),
    ).not.toThrow();
    expect(() =>
      parseDispatchResult(textScore(TEXT_SCORE_MAX_LENGTH + 1)),
    ).toThrow(/Invalid code eval result/);
  });

  it("accepts longer TEXT for ad-hoc runs", () => {
    const parsed = parseRunDispatchResult(textScore(2_000));

    expect(parsed.scores).toHaveLength(1);
    expect(parsed.scores[0].value).toHaveLength(2_000);
  });

  it("still caps ad-hoc run TEXT", () => {
    expect(() =>
      parseRunDispatchResult(textScore(CODE_EVAL_RUN_TEXT_MAX_LENGTH)),
    ).not.toThrow();
    expect(() =>
      parseRunDispatchResult(textScore(CODE_EVAL_RUN_TEXT_MAX_LENGTH + 1)),
    ).toThrow(/Invalid code eval result/);
  });

  it("keeps every other result rule on the run path", () => {
    expect(() => parseRunDispatchResult({ scores: [] })).toThrow(
      /Invalid code eval result/,
    );
    expect(() =>
      parseRunDispatchResult({
        scores: [{ name: "x", dataType: "TEXT", value: "" }],
      }),
    ).toThrow(/Invalid code eval result/);
  });
});
