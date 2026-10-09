import { describe, expect, it } from "vitest";

import { normalizeSpanIO } from "../../../parser";
import {
  capturedTraceFixtures,
  microsoftAgentProductionShapeFixture,
} from "./fixtures";

describe("OTel GenAI normalized I/O", () => {
  it.each([...capturedTraceFixtures, microsoftAgentProductionShapeFixture])(
    "$name",
    ({ spanIO, expected }) => {
      expect(normalizeSpanIO(spanIO)).toEqual({
        ...expected,
        span: spanIO,
      });
    },
  );

  it("labels an output message with a non-default type as its sender", () => {
    const envelope = (
      type: string,
      content: string,
    ): Record<string, unknown> => ({
      conversation_id: "2108461274049806337",
      request_id: "13076b683ba8da82fa38eddc6c9f1c84",
      status: "message.completed",
      message: { role: "assistant", content, type, content_type: "text" },
    });
    const spanIO = {
      input: JSON.stringify({
        messages_count: 1,
        messages: [{ role: "user", content: "白色", type: "question" }],
      }),
      output: JSON.stringify([
        envelope("answer", "白色就省心啦"),
        envelope("transfer_to_human", "正在为您转接人工客服"),
      ]),
      metadata: undefined,
    };

    expect(normalizeSpanIO(spanIO).messages).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "白色" }],
        source: "input",
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "白色就省心啦" }],
        source: "output",
      },
      {
        role: "assistant",
        senderName: "transfer_to_human",
        parts: [{ type: "text", text: "正在为您转接人工客服" }],
        source: "output",
      },
    ]);
  });
});
