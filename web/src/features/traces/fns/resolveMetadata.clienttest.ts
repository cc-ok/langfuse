import { describe, expect, it } from "vitest";

import { resolveEvalExecutionMetadata } from "./resolveMetadata";

describe("resolveEvalExecutionMetadata", () => {
  it("reads the target trace id from trace metadata", () => {
    expect(
      resolveEvalExecutionMetadata({ target_trace_id: "target-trace-id" }),
    ).toBe("target-trace-id");
  });

  // Non-string values would be rendered as React children by the badge.
  it.each([
    null,
    "target-trace-id",
    {},
    { target_trace_id: "" },
    { target_trace_id: 42 },
    { target_trace_id: { id: "nested" } },
  ])("ignores unusable metadata %j", (metadata) => {
    expect(resolveEvalExecutionMetadata(metadata)).toBeNull();
  });
});
