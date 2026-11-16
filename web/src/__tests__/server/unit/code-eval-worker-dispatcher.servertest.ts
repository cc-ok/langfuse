import { describe, expect, it, vi } from "vitest";
import type {
  CodeEvalPayload,
  DispatchInput,
} from "@langfuse/shared/src/server";
import { getWorkerCodeEvalDispatcher } from "@/src/features/public-api/server/evaluation/codeEvalWorkerDispatcher";

/**
 * The run endpoint executes evaluator code on a worker thread so the web event
 * loop stays free. These tests pin that contract: the pool reports the same
 * error taxonomy as the in-process dispatcher, a runaway script is killed
 * instead of hanging the caller, and — the point of the whole thing — timers on
 * the main thread keep firing while a script is stuck in a busy loop.
 */
const payload = (output: unknown): CodeEvalPayload => ({
  observation: { input: null, output, metadata: null, toolCalls: [] },
});

const input = (sourceCode: string, output: unknown = "{}"): DispatchInput => ({
  scope: { organizationId: "org", projectId: "project", evaluatorId: "eval" },
  runtime: { language: "TYPESCRIPT" },
  execution: { jobExecutionId: "job" },
  code: { source: sourceCode },
  payload: payload(output),
});

describe("worker code eval dispatcher", () => {
  it("runs a TypeScript evaluator and normalizes boolean scores", async () => {
    const dispatcher = getWorkerCodeEvalDispatcher(1_000);

    const result = await dispatcher.dispatch(
      input(
        `function evaluate(ctx) {
           const output = JSON.parse(ctx.observation.output);
           return { scores: [
             { name: "hit", value: output.answer === "yes", dataType: "BOOLEAN" },
             { name: "len", value: output.answer.length, dataType: "NUMERIC" },
           ] };
         }`,
        JSON.stringify({ answer: "yes" }),
      ),
    );

    expect(result.scores).toEqual([
      { name: "hit", value: 1, dataType: "BOOLEAN" },
      { name: "len", value: 3, dataType: "NUMERIC" },
    ]);
  });

  it("keeps the caller's event loop responsive while a script spins", async () => {
    const dispatcher = getWorkerCodeEvalDispatcher(200);

    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 20);

    const run = dispatcher.dispatch(
      input(`function evaluate() { while (true) {} }`),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    clearInterval(interval);

    // In-process execution would block these ticks for the whole 200ms budget.
    expect(ticks).toBeGreaterThan(3);
    await expect(run).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("reports authoring mistakes with the shared error codes", async () => {
    const dispatcher = getWorkerCodeEvalDispatcher(1_000);

    await expect(
      dispatcher.dispatch(input("function evaluate( {")),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });

    await expect(
      dispatcher.dispatch(
        input(`function evaluate() { throw new Error("boom"); }`),
      ),
    ).rejects.toMatchObject({ code: "USER_CODE_ERROR" });

    await expect(
      dispatcher.dispatch(input(`function evaluate() { return {}; }`)),
    ).rejects.toMatchObject({ code: "INVALID_RESULT" });
  });

  it("rejects non-TypeScript runtimes without touching the pool", async () => {
    const dispatcher = getWorkerCodeEvalDispatcher(1_000);
    await expect(
      dispatcher.dispatch({
        ...input("function evaluate() {}"),
        runtime: { language: "PYTHON" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_RUNTIME" });
  });

  it("stays usable after a worker was killed", async () => {
    const dispatcher = getWorkerCodeEvalDispatcher(150);
    await expect(
      dispatcher.dispatch(input(`function evaluate() { while (true) {} }`)),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        dispatcher.dispatch(
          input(
            `function evaluate(ctx) {
               return { scores: [{ name: "n", value: ${n}, dataType: "NUMERIC" }] };
             }`,
          ),
        ),
      ),
    );
    expect(results.map((r) => r.scores[0].value)).toEqual([1, 2, 3]);
  });

  it("does not leak worker errors into the caller", async () => {
    const dispatcher = getWorkerCodeEvalDispatcher(1_000);
    const onError = vi.fn();
    process.on("uncaughtException", onError);
    try {
      await dispatcher.dispatch(
        input(
          `function evaluate() { setTimeout(() => { throw new Error("async boom"); }, 0); return { scores: [{ name: "n", value: 1, dataType: "NUMERIC" }] }; }`,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onError).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", onError);
    }
  });
});
