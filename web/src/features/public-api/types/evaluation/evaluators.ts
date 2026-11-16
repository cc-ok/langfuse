import {
  EvaluatorPromptMessagesSchema,
  InvalidRequestError,
  publicApiPaginationLimitZod,
} from "@langfuse/shared";
import { z } from "zod";
import {
  PUBLIC_EVALUATOR_TYPE_CODE,
  PUBLIC_EVALUATOR_TYPE_LLM_AS_JUDGE,
  PromptVariableMapping,
  PublicCodeEvaluatorSourceCodeLanguage,
  PromptVariableMappingInput,
  PromptVariableMappingRead,
  PublicEvaluatorOutputDefinition,
  PublicEvaluatorOutputDefinitionRead,
} from "./publicEvalsContract";

export const PublicApiCreator = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
  })
  .strict();

const EvaluatorChatPrompt = EvaluatorPromptMessagesSchema;
const EvaluatorChatPromptInput = z
  .union([
    z
      .string()
      .min(1)
      .transform((content) => [{ role: "user" as const, content }]),
    EvaluatorChatPrompt,
  ])
  .pipe(EvaluatorChatPrompt);

const EvaluatorVersionBase = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  createdAt: z.coerce.date(),
  createdBy: PublicApiCreator.nullable(),
});

const EvaluatorModelConfig = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();

const LlmAsJudgeEvaluatorVersion = EvaluatorVersionBase.extend({
  type: z.literal(PUBLIC_EVALUATOR_TYPE_LLM_AS_JUDGE),
  prompt: EvaluatorChatPrompt,
  variables: z.array(z.string()),
  variableMapping: z.array(PromptVariableMappingRead).nullable(),
  modelConfig: EvaluatorModelConfig.nullable(),
  outputDefinition: PublicEvaluatorOutputDefinitionRead,
}).strict();

const CodeEvaluatorVersion = EvaluatorVersionBase.extend({
  type: z.literal(PUBLIC_EVALUATOR_TYPE_CODE),
  sourceCode: z.string().min(1),
  sourceCodeLanguage: PublicCodeEvaluatorSourceCodeLanguage,
}).strict();

export const EvaluatorVersion = z.discriminatedUnion("type", [
  LlmAsJudgeEvaluatorVersion,
  CodeEvaluatorVersion,
]);

const EvaluationRuleAssignment = z
  .object({
    evaluationRuleId: z.string(),
    variableMappingOverride: z.array(PromptVariableMapping).optional(),
  })
  .strict();

const EvaluatorBase = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: PublicApiCreator.nullable(),
  status: z.enum(["active", "paused"]),
  pausedAt: z.coerce.date().nullable(),
  pausedReason: z.string().nullable(),
  pausedMessage: z.string().nullable(),
  evaluationRuleAssignments: z.array(EvaluationRuleAssignment),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  versionId: z.string(),
  version: z.number().int().positive(),
  versionCreatedAt: z.coerce.date(),
  versionCreatedBy: PublicApiCreator.nullable(),
});

export const LlmAsJudgeEvaluator = EvaluatorBase.extend({
  type: z.literal(PUBLIC_EVALUATOR_TYPE_LLM_AS_JUDGE),
  prompt: EvaluatorChatPrompt,
  variables: z.array(z.string()),
  variableMapping: z.array(PromptVariableMappingRead).nullable(),
  modelConfig: EvaluatorModelConfig.nullable(),
  outputDefinition: PublicEvaluatorOutputDefinitionRead,
}).strict();

const CodeEvaluator = EvaluatorBase.extend({
  type: z.literal(PUBLIC_EVALUATOR_TYPE_CODE),
  sourceCode: z.string().min(1),
  sourceCodeLanguage: PublicCodeEvaluatorSourceCodeLanguage,
}).strict();

export const Evaluator = z.discriminatedUnion("type", [
  LlmAsJudgeEvaluator,
  CodeEvaluator,
]);

const LlmAsJudgeEvaluatorDefinition = z
  .object({
    type: z.literal(PUBLIC_EVALUATOR_TYPE_LLM_AS_JUDGE),
    prompt: EvaluatorChatPromptInput,
    modelConfig: EvaluatorModelConfig.nullable().optional(),
    variableMapping: z.array(PromptVariableMappingInput).nullable().optional(),
    outputDefinition: PublicEvaluatorOutputDefinition,
  })
  .strict();

const CodeEvaluatorDefinition = z
  .object({
    type: z.literal(PUBLIC_EVALUATOR_TYPE_CODE),
    sourceCode: z.string().min(1),
    sourceCodeLanguage: PublicCodeEvaluatorSourceCodeLanguage,
  })
  .strict();

const _EvaluatorDefinition = z.discriminatedUnion("type", [
  LlmAsJudgeEvaluatorDefinition,
  CodeEvaluatorDefinition,
]);

const CreateEvaluatorMetadata = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().max(2_000).nullable().optional(),
});

export const CreateEvaluatorBody = z.discriminatedUnion("type", [
  CreateEvaluatorMetadata.extend(LlmAsJudgeEvaluatorDefinition.shape).strict(),
  CreateEvaluatorMetadata.extend(CodeEvaluatorDefinition.shape).strict(),
]);

const UpdateEvaluatorMetadata = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();

export const UpdateEvaluatorBody = z.union([
  UpdateEvaluatorMetadata.extend(LlmAsJudgeEvaluatorDefinition.shape).strict(),
  UpdateEvaluatorMetadata.extend(CodeEvaluatorDefinition.shape).strict(),
  UpdateEvaluatorMetadata.refine((value) => Object.keys(value).length > 0, {
    message: "Request body cannot be empty",
  }),
]);

const decodeCursor = (value: string) => {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf-8"));
  } catch (_error) {
    throw new InvalidRequestError("Invalid cursor format");
  }
};

const ResourceCursor = z.discriminatedUnion("v", [
  z.object({
    v: z.literal(1),
    lastCreatedAt: z.iso.datetime({ offset: true }),
    lastId: z.string(),
  }),
]);

export type ResourceCursorType = z.infer<typeof ResourceCursor>;

export const EncodedResourceCursor = z
  .string()
  .transform(decodeCursor)
  .pipe(ResourceCursor);

export const EncodedResourceCursorString = z
  .string()
  .describe("Opaque cursor for pagination");

export const encodeResourceCursor = (cursor: ResourceCursorType) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

const EvaluatorVersionCursor = z.discriminatedUnion("v", [
  z.object({ v: z.literal(1), version: z.number().int().positive() }),
]);

const EncodedEvaluatorVersionCursor = z
  .string()
  .transform(decodeCursor)
  .pipe(EvaluatorVersionCursor);

export const ListEvaluatorsQuery = z
  .object({
    limit: publicApiPaginationLimitZod,
    cursor: EncodedResourceCursor.optional(),
  })
  .strict();

export const ListEvaluatorsResponse = z
  .object({
    data: z.array(Evaluator),
    meta: z.object({ cursor: EncodedResourceCursorString.optional() }).strict(),
  })
  .strict();

export const EvaluatorIdQuery = z.object({ evaluatorId: z.string() }).strict();

export const ListEvaluatorVersionsQuery = z
  .object({
    evaluatorId: z.string(),
    limit: publicApiPaginationLimitZod,
    cursor: EncodedEvaluatorVersionCursor.optional(),
  })
  .strict();

export const ListEvaluatorVersionsResponse = z
  .object({
    data: z.array(EvaluatorVersion),
    meta: z.object({ cursor: EncodedResourceCursorString.optional() }).strict(),
  })
  .strict();

export const DeleteEvaluatorResponse = z.object({ id: z.string() }).strict();

export type EvaluatorDefinitionType = z.infer<typeof _EvaluatorDefinition>;
export type CreateEvaluatorBodyType = z.infer<typeof CreateEvaluatorBody>;
export type UpdateEvaluatorBodyType = z.infer<typeof UpdateEvaluatorBody>;

/**
 * Ad-hoc execution of one code evaluator (`POST /api/public/unstable/evaluators/{id}/run`).
 *
 * The payload mirrors what a scheduled evaluation sees for an observation, so an
 * evaluator behaves identically whether it runs from an evaluation rule or from
 * this endpoint. Callers are expected to pass already-stringified `input`/
 * `output` values (the same bytes they ingest over OTLP), which keeps the JSON
 * parsing branches inside evaluator code on the same path.
 */
export const RUN_EVALUATOR_PAYLOAD_MAX_BYTES = 256 * 1024;
export const RUN_EVALUATOR_TIMEOUT_MIN_MS = 50;
export const RUN_EVALUATOR_TIMEOUT_MAX_MS = 10_000;

const RunEvaluatorExperiment = z
  .object({
    itemExpectedOutput: z.unknown().optional(),
    itemMetadata: z.unknown().optional(),
  })
  .strict();

const RunEvaluatorPayload = z
  .object({
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.unknown().optional(),
    toolCalls: z.array(z.unknown()).optional(),
    experiment: RunEvaluatorExperiment.optional(),
  })
  .strict();

export const RunEvaluatorBody = z
  .object({
    payload: RunEvaluatorPayload,
    timeoutMs: z
      .number()
      .int()
      .min(RUN_EVALUATOR_TIMEOUT_MIN_MS)
      .max(RUN_EVALUATOR_TIMEOUT_MAX_MS)
      .optional(),
  })
  .strict();

const RunEvaluatorScoreDataType = z.enum([
  "NUMERIC",
  "CATEGORICAL",
  "BOOLEAN",
  "TEXT",
]);

const RunEvaluatorScore = z
  .object({
    name: z.string(),
    value: z.union([z.number(), z.string()]),
    dataType: RunEvaluatorScoreDataType.optional(),
    comment: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const RunEvaluatorResponse = z
  .object({
    evaluatorId: z.string(),
    evaluatorName: z.string(),
    versionId: z.string(),
    version: z.number().int(),
    scores: z.array(RunEvaluatorScore),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type RunEvaluatorBodyType = z.infer<typeof RunEvaluatorBody>;
export type RunEvaluatorResponseType = z.infer<typeof RunEvaluatorResponse>;
