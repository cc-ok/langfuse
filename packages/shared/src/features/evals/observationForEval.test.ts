import { describe, expect, it } from "vitest";
import {
  mapEventEvalFilterColumnIdToField,
  type ObservationForEval,
  zipObservationToolCalls,
} from "./observationForEval";
import { extractObservationVariables } from "../../server/evals/extractObservationVariables";

describe("zipObservationToolCalls", () => {
  it("zips ClickHouse parallel arrays into named tool calls with parsed arguments", () => {
    const result = zipObservationToolCalls({
      tool_calls: [
        '{"id":"call_1","arguments":"{\\"query\\":\\"weather\\"}","type":"function","index":0}',
        '{"id":"toolu_2","arguments":"{\\"city\\":\\"Berlin\\"}","type":"tool_use","index":1}',
      ],
      tool_call_names: ["search", "get_weather"],
    });

    expect(result).toEqual([
      {
        id: "call_1",
        name: "search",
        arguments: { query: "weather" },
        type: "function",
        index: 0,
      },
      {
        id: "toolu_2",
        name: "get_weather",
        arguments: { city: "Berlin" },
        type: "tool_use",
        index: 1,
      },
    ]);
  });

  it("returns an empty array for observations without tool calls", () => {
    expect(
      zipObservationToolCalls({ tool_calls: [], tool_call_names: [] }),
    ).toEqual([]);
  });

  it("keeps unparsable arguments as the raw string", () => {
    const result = zipObservationToolCalls({
      tool_calls: [
        '{"id":"call_1","arguments":"not json","type":"","index":0}',
      ],
      tool_call_names: ["search"],
    });

    expect(result[0]?.arguments).toBe("not json");
  });

  it("falls back to defaults when an entry is missing or malformed", () => {
    const result = zipObservationToolCalls({
      tool_calls: ["not json at all"],
      tool_call_names: ["search", "unmatched"],
    });

    expect(result).toEqual([
      { id: "", name: "search", arguments: {}, type: "", index: 0 },
      { id: "", name: "unmatched", arguments: {}, type: "", index: 0 },
    ]);
  });

  it("accepts entries that are already objects", () => {
    const result = zipObservationToolCalls({
      tool_calls: [
        { id: "call_1", arguments: { a: 1 }, type: "function", index: 2 },
      ],
      tool_call_names: ["search"],
    });

    expect(result).toEqual([
      {
        id: "call_1",
        name: "search",
        arguments: { a: 1 },
        type: "function",
        index: 2,
      },
    ]);
  });
});

describe("mapEventEvalFilterColumnIdToField", () => {
  it("maps filters backed directly by the evaluation payload", () => {
    const observation = {
      provided_model_name: "gpt-4o",
      prompt_name: "support-agent",
      prompt_version: 2,
      release: "2026-08",
      status_message: "rate limit exceeded",
      experiment_name: "checkout-eval",
    } as ObservationForEval;

    expect(
      mapEventEvalFilterColumnIdToField(observation, "providedModelName"),
    ).toBe("gpt-4o");
    expect(mapEventEvalFilterColumnIdToField(observation, "promptName")).toBe(
      "support-agent",
    );
    expect(
      mapEventEvalFilterColumnIdToField(observation, "promptVersion"),
    ).toBe(2);
    expect(mapEventEvalFilterColumnIdToField(observation, "release")).toBe(
      "2026-08",
    );
    expect(
      mapEventEvalFilterColumnIdToField(observation, "statusMessage"),
    ).toBe("rate limit exceeded");
    expect(
      mapEventEvalFilterColumnIdToField(observation, "experimentName"),
    ).toBe("checkout-eval");
  });

  it("maps the experiment root filter to a boolean", () => {
    expect(
      mapEventEvalFilterColumnIdToField(
        {
          span_id: "root-span",
          experiment_item_root_span_id: "root-span",
        } as ObservationForEval,
        "isExperimentItemRootSpan",
      ),
    ).toBe(true);
    expect(
      mapEventEvalFilterColumnIdToField(
        {
          span_id: "child-span",
          experiment_item_root_span_id: "root-span",
        } as ObservationForEval,
        "isExperimentItemRootSpan",
      ),
    ).toBe(false);
  });
});

describe("PRE-LABEL text metadata", () => {
  it("resolves a JSON-encoded `pre` object through the item metadata column", () => {
    // Callers write PRE-LABEL texts as one JSON object under `pre`
    // (`langfuse.experiment.item.metadata.pre`). Ingestion keeps it as a
    // string, so the read side parses it before JSONPath can see it.
    const observation = {
      experiment_item_metadata: {
        pre: '{"history_text": "【第1轮】用户: 退货多久到账 😀\\n客服回答: 3-5 个工作日"}',
      },
    } as unknown as ObservationForEval;

    const [resolved] = extractObservationVariables({
      observation,
      variableMapping: [
        {
          templateVariable: "history_text",
          selectedColumnId: "experimentItemMetadata",
          jsonSelector: "$.pre.history_text",
        },
      ],
    });

    expect(resolved.value).toBe(
      "【第1轮】用户: 退货多久到账 😀\n客服回答: 3-5 个工作日",
    );
  });
});
