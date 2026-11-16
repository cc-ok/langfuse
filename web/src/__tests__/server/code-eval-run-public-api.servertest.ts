import { randomUUID } from "node:crypto";
import {
  EvaluatorBlockReason,
  EvaluatorSourceCodeLanguage,
} from "@prisma/client";
import { EvalTemplateType } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  createBasicAuthHeader,
  createOrgProjectAndApiKey,
  queryClickhouse,
} from "@langfuse/shared/src/server";
import {
  makeAPICall,
  makeZodVerifiedAPICall,
} from "@/src/__tests__/test-utils";
import { codeDefinition } from "@/src/__tests__/server/stable-evaluation-public-api-test-utils";
import {
  Evaluator,
  RunEvaluatorResponse,
} from "@/src/features/public-api/types/evaluation/evaluators";

const RUN_URL = (evaluatorId: string) =>
  `/api/public/unstable/evaluators/${evaluatorId}/run`;

async function createPythonEvaluator(projectId: string) {
  const evaluator = await prisma.evaluator.create({
    data: {
      projectId,
      name: `python-${randomUUID()}`,
      type: EvalTemplateType.CODE,
      versions: {
        create: {
          version: 1,
          sourceCode: "def evaluate(ctx):\n  return {'scores': []}\n",
          sourceCodeLanguage: EvaluatorSourceCodeLanguage.PYTHON,
        },
      },
    },
  });
  return evaluator.id;
}

/** Evaluator that always returns one numeric score; used where the payload does not matter. */
const SCORED_SOURCE = `
  function evaluate() {
    return { scores: [{ name: "x", value: 1, dataType: "NUMERIC" }] };
  }
`;

/**
 * Ad-hoc code evaluator runs (`POST /api/public/unstable/evaluators/{id}/run`).
 *
 * The endpoint exists so callers can reuse evaluator logic before the data is
 * ingested, which only works if the run is side-effect free: no scores, no job
 * configurations, no executions, no traces. Several tests below assert exactly
 * that.
 *
 * Requires a server whose code-eval dispatcher is configured (dev/test default
 * to `insecure-local`). Otherwise every run answers 503.
 *
 * The concurrency gate is not covered here: with the in-process dispatcher the
 * event loop serializes runs, so a burst queues instead of tripping the limit.
 * It only applies to async dispatchers (Lambda / external HTTP).
 */
describe("unstable code evaluator run public API", () => {
  const orgIds: string[] = [];

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  async function createEvaluator(sourceCode: string) {
    const { auth, org, project } = await createOrgProjectAndApiKey();
    orgIds.push(org.id);

    const response = await makeZodVerifiedAPICall(
      Evaluator,
      "POST",
      "/api/public/v2/evaluators",
      { name: `run-test-${randomUUID()}`, ...codeDefinition(sourceCode) },
      auth,
      201,
    );

    return { auth, project, evaluator: response.body };
  }

  it("runs the latest version and returns the scores without persisting anything", async () => {
    const { auth, project, evaluator } = await createEvaluator(`
      function evaluate(ctx) {
        const output =
          typeof ctx.observation.output === "string"
            ? JSON.parse(ctx.observation.output)
            : ctx.observation.output;
        const answer = (output && output.answer) || "";

        return {
          scores: [
            { name: "pre:answer", value: answer.length > 0, dataType: "BOOLEAN" },
            { name: "pre:transfer", value: false, dataType: "BOOLEAN" },
            { name: "pre:length", value: answer.length, dataType: "NUMERIC" },
          ],
        };
      }
    `);

    const jobConfigCountBefore = await prisma.jobConfiguration.count({
      where: { projectId: project.id },
    });
    const jobExecutionCountBefore = await prisma.jobExecution.count({
      where: { projectId: project.id },
    });

    const response = await makeZodVerifiedAPICall(
      RunEvaluatorResponse,
      "POST",
      RUN_URL(evaluator.id),
      {
        payload: {
          input: JSON.stringify({ question: "订单到哪了" }),
          output: JSON.stringify({ answer: "已发出" }),
          metadata: { level: "turn" },
        },
      },
      auth,
    );

    expect(response.body).toMatchObject({
      evaluatorId: evaluator.id,
      evaluatorName: evaluator.name,
      version: 1,
      scores: [
        { name: "pre:answer", value: 1, dataType: "BOOLEAN", comment: null },
        { name: "pre:transfer", value: 0, dataType: "BOOLEAN", comment: null },
        { name: "pre:length", value: 3, dataType: "NUMERIC" },
      ],
    });
    expect(response.body.durationMs).toBeGreaterThanOrEqual(0);

    await expect(
      prisma.jobConfiguration.count({ where: { projectId: project.id } }),
    ).resolves.toBe(jobConfigCountBefore);
    await expect(
      prisma.jobExecution.count({ where: { projectId: project.id } }),
    ).resolves.toBe(jobExecutionCountBefore);

    const scores = await queryClickhouse<{ count: string }>({
      query: `SELECT count() as count FROM scores WHERE project_id = {projectId: String}`,
      params: { projectId: project.id },
      tags: { projectId: project.id },
    });
    expect(Number(scores[0]?.count ?? 0)).toBe(0);
  });

  it("exposes the same ctx shape a scheduled evaluation gets", async () => {
    const { auth, evaluator } = await createEvaluator(`
      function evaluate(ctx) {
        const matches =
          ctx.observation.input === '{"question":"hi"}' &&
          ctx.observation.output === '{"answer":"hello"}' &&
          ctx.observation.metadata.level === "turn" &&
          Array.isArray(ctx.observation.toolCalls) &&
          ctx.observation.toolCalls.length === 0 &&
          ctx.experiment.itemExpectedOutput === '{"answer":"hello"}' &&
          ctx.experiment.itemMetadata.turn === 3;

        return { scores: [{ name: "ctx-parity", value: matches, dataType: "BOOLEAN" }] };
      }
    `);

    const response = await makeZodVerifiedAPICall(
      RunEvaluatorResponse,
      "POST",
      RUN_URL(evaluator.id),
      {
        payload: {
          input: '{"question":"hi"}',
          output: '{"answer":"hello"}',
          metadata: { level: "turn" },
          toolCalls: [],
          experiment: {
            itemExpectedOutput: '{"answer":"hello"}',
            itemMetadata: { turn: 3 },
          },
        },
      },
      auth,
    );

    expect(response.body.scores).toEqual([
      { name: "ctx-parity", value: 1, dataType: "BOOLEAN", comment: null },
    ]);
  });

  it("honors timeoutMs with a 504 instead of hanging", async () => {
    const { auth, evaluator } = await createEvaluator(`
      function evaluate() {
        while (true) {}
      }
    `);

    const { body, status } = await makeAPICall<{
      code: string;
      message: string;
    }>(
      "POST",
      RUN_URL(evaluator.id),
      { payload: { output: "{}" }, timeoutMs: 100 },
      auth,
    );

    expect(status).toBe(504);
    expect(body.code).toBe("internal_error");
    expect(body.message).toContain("timed out");
  });

  it("rejects non-code evaluators", async () => {
    const { auth, org } = await createOrgProjectAndApiKey();
    orgIds.push(org.id);
    const llm = await makeZodVerifiedAPICall(
      Evaluator,
      "POST",
      "/api/public/v2/evaluators",
      {
        name: `llm-${randomUUID()}`,
        type: "llm_as_judge",
        prompt: "Score {{input}}",
        modelConfig: null,
        variableMapping: null,
        outputDefinition: { dataType: "NUMERIC", minValue: 0, maxValue: 1 },
      },
      auth,
      201,
    );

    const { body, status } = await makeAPICall<{ code: string }>(
      "POST",
      RUN_URL(llm.body.id),
      { payload: { output: "{}" } },
      auth,
    );

    expect(status).toBe(400);
    expect(body.code).toBe("invalid_request");
  });

  it("rejects non-TypeScript code evaluators", async () => {
    const { auth, org, project } = await createOrgProjectAndApiKey();
    orgIds.push(org.id);
    // Created straight in the DB: the public API refuses PYTHON evaluators when
    // the configured dispatcher only supports TypeScript, but such rows still
    // exist on deployments that ran with another dispatcher.
    const evaluatorId = await createPythonEvaluator(project.id);

    const { body, status } = await makeAPICall<{ message: string }>(
      "POST",
      RUN_URL(evaluatorId),
      { payload: { output: "{}" } },
      auth,
    );

    expect(status).toBe(400);
    expect(body.message).toContain("TYPESCRIPT");
  });

  it("rejects paused evaluators", async () => {
    const { auth, evaluator } = await createEvaluator(SCORED_SOURCE);
    await prisma.evaluator.update({
      where: { id: evaluator.id },
      data: {
        blockedAt: new Date(),
        blockReason: EvaluatorBlockReason.EVAL_MODEL_UNAVAILABLE,
        blockMessage: "paused for test",
      },
    });

    const { body, status } = await makeAPICall<{ code: string }>(
      "POST",
      RUN_URL(evaluator.id),
      { payload: { output: "{}" } },
      auth,
    );

    expect(status).toBe(409);
    expect(body.code).toBe("conflict");
  });

  it("rejects evaluators from another project", async () => {
    const { evaluator } = await createEvaluator(SCORED_SOURCE);
    const { auth: otherAuth, org } = await createOrgProjectAndApiKey();
    orgIds.push(org.id);

    const { body, status } = await makeAPICall<{ code: string }>(
      "POST",
      RUN_URL(evaluator.id),
      { payload: { output: "{}" } },
      otherAuth,
    );

    expect(status).toBe(404);
    expect(body.code).toBe("resource_not_found");
  });

  it("surfaces authoring errors as 400 with the dispatcher code", async () => {
    const { auth, evaluator } = await createEvaluator(`
      function evaluate( {
        return { scores: [] };
      }
    `);

    const { body, status } = await makeAPICall<{ message: string }>(
      "POST",
      RUN_URL(evaluator.id),
      { payload: { output: "{}" } },
      auth,
    );

    expect(status).toBe(400);
    expect(body.message).toContain("INVALID_SOURCE");
  });

  it("rejects payloads above the size limit", async () => {
    const { auth, evaluator } = await createEvaluator(SCORED_SOURCE);

    const { status } = await makeAPICall(
      "POST",
      RUN_URL(evaluator.id),
      { payload: { output: "x".repeat(300 * 1024) } },
      auth,
    );

    expect(status).toBe(422);
  });

  it("requires authentication", async () => {
    const { evaluator } = await createEvaluator(SCORED_SOURCE);

    // Never reuse the shared fake key from `test-utils`: other suites create it
    // for real (`scim-api.servertest`), which would make this flaky in parallel.
    const { status } = await makeAPICall(
      "POST",
      RUN_URL(evaluator.id),
      { payload: { output: "{}" } },
      createBasicAuthHeader("pk-lf-unknown-key", "sk-lf-unknown-key"),
    );

    expect(status).toBe(401);
  });
});
