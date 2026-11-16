import { EvaluatorSourceCodeLanguage } from "@prisma/client";
import {
  EvalTemplateType,
  GatewayTimeoutError,
  InvalidRequestError,
  LangfuseConflictError,
  LangfuseNotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { env } from "@langfuse/shared/src/env";
import {
  createW3CTraceId,
  LocalCodeEvalDispatcher,
  resolveConfiguredCodeEvalDispatcher,
  runCodeBasedEvaluationDispatch,
  type CodeEvalDispatcher,
  type CodeEvalUserVisibleError,
  type ExtractedVariable,
} from "@langfuse/shared/src/server";
import {
  RUN_EVALUATOR_PAYLOAD_MAX_BYTES,
  RUN_EVALUATOR_TIMEOUT_MAX_MS,
  RUN_EVALUATOR_TIMEOUT_MIN_MS,
  type RunEvaluatorBodyType,
  type RunEvaluatorResponseType,
} from "@/src/features/public-api/types/evaluation/evaluators";

const DEFAULT_RUN_TIMEOUT_MS = 1_000;

/**
 * Process-local concurrency gate for genuinely concurrent dispatches.
 *
 * With `insecure-local` user code runs synchronously in `vm.runInContext`, so
 * the event loop serializes runs on its own: a burst queues behind the running
 * script and never reaches this limit (nothing else can start while the loop is
 * blocked). The gate only bites with async dispatchers (AWS Lambda / external
 * HTTP), where many runs are genuinely in flight at once.
 */
let inFlightRuns = 0;

/** Dispatcher failures that are our problem (infrastructure), not the author's. */
const DISPATCHER_UNAVAILABLE_CODES = new Set<string>([
  "LAMBDA_CONCURRENCY_LIMIT",
  "LAMBDA_CONFIGURATION_ERROR",
  "LAMBDA_INVOCATION_ERROR",
  "EXTERNAL_CONFIGURATION_ERROR",
  "EXTERNAL_INVOCATION_ERROR",
]);

type RunnableEvaluator = {
  id: string;
  name: string;
  orgId: string;
  version: {
    id: string;
    number: number;
    sourceCode: string;
    sourceCodeLanguage: EvaluatorSourceCodeLanguage;
  };
};

export async function runEvaluatorForPublicApi(params: {
  projectId: string;
  evaluatorId: string;
  body: RunEvaluatorBodyType;
}): Promise<RunEvaluatorResponseType> {
  // Acquire before the first await so async dispatchers bound the whole request
  // (DB lookup included), not just the script execution.
  const limit = env.LANGFUSE_CODE_EVAL_RUN_CONCURRENCY;
  if (inFlightRuns >= limit) {
    throw new ServiceUnavailableError(
      `Too many concurrent code evaluator runs (limit ${limit}), retry shortly`,
      { retryAfterSeconds: 1 },
    );
  }

  inFlightRuns += 1;
  try {
    return await executeRun(params);
  } finally {
    inFlightRuns -= 1;
  }
}

async function executeRun(params: {
  projectId: string;
  evaluatorId: string;
  body: RunEvaluatorBodyType;
}): Promise<RunEvaluatorResponseType> {
  const startedAt = Date.now();
  const evaluator = await loadRunnableEvaluator(params);
  assertPayloadSize(params.body.payload);

  const executionTraceId = createW3CTraceId();
  const result = await runCodeBasedEvaluationDispatch({
    dispatcher: resolveRunDispatcher(params.body.timeoutMs),
    organizationId: evaluator.orgId,
    projectId: params.projectId,
    executionTraceId,
    // Nothing is persisted for ad-hoc runs; this id only tags the (unwritten)
    // execution trace the shared dispatch contract expects.
    jobExecutionId: executionTraceId,
    evaluator: { id: evaluator.id },
    version: {
      sourceCode: evaluator.version.sourceCode,
      sourceCodeLanguage: evaluator.version.sourceCodeLanguage,
    },
    extractedVariables: buildVariables(params.body.payload),
    hasExperimentContext: Boolean(params.body.payload.experiment),
    traceName: `Run evaluator: ${evaluator.name}`,
    metadata: {},
    // Deliberately no `writeTrace`: ad-hoc runs add no traces and no scores.
  });

  if (!result.success) {
    throwOnDispatchFailure(result.error);
  }

  return {
    evaluatorId: evaluator.id,
    evaluatorName: evaluator.name,
    versionId: evaluator.version.id,
    version: evaluator.version.number,
    scores: result.scores.map((score) => ({
      name: score.name,
      value: score.value,
      dataType: score.dataType,
      comment: score.comment ?? null,
      metadata: score.metadata,
    })),
    durationMs: Date.now() - startedAt,
  };
}

/** Load the latest version of a code evaluator that may be run ad hoc. */
async function loadRunnableEvaluator(params: {
  projectId: string;
  evaluatorId: string;
}): Promise<RunnableEvaluator> {
  const evaluator = await prisma.evaluator.findFirst({
    where: { id: params.evaluatorId, projectId: params.projectId },
    select: {
      id: true,
      name: true,
      type: true,
      blockedAt: true,
      project: { select: { orgId: true } },
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: {
          id: true,
          version: true,
          sourceCode: true,
          sourceCodeLanguage: true,
        },
      },
    },
  });

  // Cross-project ids are indistinguishable from unknown ids on purpose.
  if (!evaluator) {
    throw new LangfuseNotFoundError("Evaluator not found");
  }
  if (evaluator.type !== EvalTemplateType.CODE) {
    throw new InvalidRequestError(
      "This endpoint only runs code evaluators; LLM-as-a-judge, decision-model and facet evaluators are not supported",
    );
  }
  if (evaluator.blockedAt) {
    throw new LangfuseConflictError(
      "Evaluator is paused. Reactivate it in Langfuse before running it through the public API.",
    );
  }

  const version = evaluator.versions[0];
  if (!version?.sourceCode) {
    throw new LangfuseNotFoundError("Evaluator version not found");
  }
  if (version.sourceCodeLanguage !== EvaluatorSourceCodeLanguage.TYPESCRIPT) {
    throw new InvalidRequestError(
      "This endpoint only runs TYPESCRIPT code evaluators",
    );
  }

  return {
    id: evaluator.id,
    name: evaluator.name,
    orgId: evaluator.project.orgId,
    version: {
      id: version.id,
      number: version.version,
      sourceCode: version.sourceCode,
      sourceCodeLanguage: version.sourceCodeLanguage,
    },
  };
}

function assertPayloadSize(payload: RunEvaluatorBodyType["payload"]) {
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > RUN_EVALUATOR_PAYLOAD_MAX_BYTES) {
    throw new PayloadTooLargeError(
      `Evaluator payload is ${bytes} bytes, which exceeds the ${RUN_EVALUATOR_PAYLOAD_MAX_BYTES} byte limit`,
    );
  }
}

/**
 * The local dispatcher fixes its timeout at construction time, so a per-request
 * budget needs its own instance. Remote dispatchers carry their own limits.
 */
function resolveRunDispatcher(requested?: number): CodeEvalDispatcher {
  const dispatcher = resolveConfiguredCodeEvalDispatcher();
  if (!dispatcher) {
    throw new ServiceUnavailableError(
      "Code eval dispatcher is not configured on this instance",
    );
  }
  if (dispatcher.name !== "insecure-local") {
    return dispatcher;
  }

  // An explicit budget may not stretch the event-loop stall past the
  // operator's instance-wide ceiling.
  const ceiling = Math.min(
    RUN_EVALUATOR_TIMEOUT_MAX_MS,
    env.LANGFUSE_CODE_EVAL_LOCAL_TIMEOUT_MS,
  );
  const timeoutMs = Math.min(
    Math.max(requested ?? DEFAULT_RUN_TIMEOUT_MS, RUN_EVALUATOR_TIMEOUT_MIN_MS),
    ceiling,
  );
  return new LocalCodeEvalDispatcher({ timeoutMs });
}

/**
 * Mirrors the variable set a scheduled code evaluation receives
 * (`getCodeEvalVariableMapping`), so `ctx` looks the same on both paths.
 */
function buildVariables(
  payload: RunEvaluatorBodyType["payload"],
): ExtractedVariable[] {
  const variables: ExtractedVariable[] = [
    { var: "input", value: payload.input ?? null },
    { var: "output", value: payload.output ?? null },
    { var: "metadata", value: payload.metadata ?? null },
    { var: "toolCalls", value: payload.toolCalls ?? [] },
  ];

  const experiment = payload.experiment;
  if (experiment?.itemExpectedOutput !== undefined) {
    variables.push({
      var: "experimentItemExpectedOutput",
      value: experiment.itemExpectedOutput,
    });
  }
  if (experiment?.itemMetadata !== undefined) {
    variables.push({
      var: "experimentItemMetadata",
      value: experiment.itemMetadata,
    });
  }

  return variables;
}

function throwOnDispatchFailure(error: CodeEvalUserVisibleError): never {
  if (error.code === "TIMEOUT") {
    throw new GatewayTimeoutError(`Code evaluator timed out: ${error.message}`);
  }
  if (DISPATCHER_UNAVAILABLE_CODES.has(error.code)) {
    throw new ServiceUnavailableError(
      `Code evaluator dispatcher unavailable: ${error.message}`,
      { retryAfterSeconds: 2 },
    );
  }
  // INVALID_SOURCE / INVALID_RESULT / USER_CODE_ERROR / payload + result size
  // limits are all authoring problems; surface them as 400 with the code.
  throw new InvalidRequestError(
    `Code evaluator failed (${error.code}): ${error.message}`,
  );
}
