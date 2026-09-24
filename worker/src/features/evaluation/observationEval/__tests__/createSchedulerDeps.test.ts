import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobExecutionStatus } from "@prisma/client";
import { EvalTemplateType } from "@langfuse/shared/src/db";

const addToLLMQueue = vi.fn();
const addToCodeQueue = vi.fn();
const getLLMQueueInstance = vi.fn(() => ({ add: addToLLMQueue }));
const getCodeQueueInstance = vi.fn(() => ({ add: addToCodeQueue }));
const { upsertJobExecution } = vi.hoisted(() => ({
  upsertJobExecution: vi.fn(),
}));

vi.mock("@langfuse/shared/src/server", async () => {
  const actual = await vi.importActual("@langfuse/shared/src/server");

  return {
    ...actual,
    LLMAsJudgeExecutionQueue: {
      getInstance: getLLMQueueInstance,
    },
    CodeEvalExecutionQueue: {
      getInstance: getCodeQueueInstance,
    },
  };
});

vi.mock("@langfuse/shared/src/db", async () => {
  const actual = await vi.importActual("@langfuse/shared/src/db");

  return {
    ...actual,
    prisma: {
      jobExecution: { upsert: upsertJobExecution },
    },
  };
});

describe("createObservationEvalSchedulerDeps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes LLM-as-judge observation eval jobs to the LLM queue", async () => {
    const { createObservationEvalSchedulerDeps } =
      await import("../createSchedulerDeps");

    await createObservationEvalSchedulerDeps().enqueueEvalJob({
      projectId: "project-1",
      jobExecutionId: "job-1",
      observationS3Path: "evals/project-1/observations/obs-1.json",
      delay: 10,
      evalTemplateType: EvalTemplateType.LLM_AS_JUDGE,
    });

    expect(getLLMQueueInstance).toHaveBeenCalledWith({
      shardingKey: "project-1-job-1",
    });
    expect(addToLLMQueue).toHaveBeenCalledWith(
      "llm-as-a-judge-execution-queue",
      expect.objectContaining({
        name: "llm-as-a-judge-execution-job",
        id: "job-1",
        payload: expect.objectContaining({ projectId: "project-1" }),
      }),
      { delay: 10 },
    );
    expect(getCodeQueueInstance).not.toHaveBeenCalled();
  });

  it("routes code observation eval jobs to the code eval queue", async () => {
    const { createObservationEvalSchedulerDeps } =
      await import("../createSchedulerDeps");

    await createObservationEvalSchedulerDeps().enqueueEvalJob({
      projectId: "project-1",
      jobExecutionId: "job-2",
      observationS3Path: "evals/project-1/observations/obs-1.json",
      delay: 20,
      evalTemplateType: EvalTemplateType.CODE,
    });

    expect(getCodeQueueInstance).toHaveBeenCalledWith({
      shardingKey: "project-1-job-2",
    });
    expect(addToCodeQueue).toHaveBeenCalledWith(
      "code-eval-execution-queue",
      expect.objectContaining({
        name: "code-eval-execution-job",
        id: "job-2",
        payload: expect.objectContaining({ projectId: "project-1" }),
      }),
      { delay: 20 },
    );
    expect(getLLMQueueInstance).not.toHaveBeenCalled();
  });

  it("includes a mapping override on the observation eval payload", async () => {
    const { createObservationEvalSchedulerDeps } =
      await import("../createSchedulerDeps");
    const variableMapping = [
      { templateVariable: "output", selectedColumnId: "input" },
    ];

    await createObservationEvalSchedulerDeps().enqueueEvalJob({
      projectId: "project-1",
      jobExecutionId: "job-3",
      observationS3Path: "evals/project-1/observations/obs-1.json",
      delay: 0,
      evalTemplateType: EvalTemplateType.LLM_AS_JUDGE,
      evaluatorId: "evaluator-1",
      variableMapping,
    });

    expect(addToLLMQueue).toHaveBeenCalledWith(
      "llm-as-a-judge-execution-queue",
      expect.objectContaining({
        payload: expect.objectContaining({
          evaluatorId: "evaluator-1",
          variableMapping,
        }),
      }),
      { delay: 0 },
    );
  });

  const jobExecutionParams = (jobInputExperimentId: string | null) => ({
    id: "job-3",
    projectId: "project-1",
    jobConfigurationId: "rule-1",
    jobInputTraceId: "trace-1",
    jobInputObservationId: "obs-1",
    jobInputExperimentId,
    jobTemplateId: null,
    status: JobExecutionStatus.PENDING,
  });

  it("persists the experiment run the evaluated target belongs to", async () => {
    upsertJobExecution.mockResolvedValue({ id: "job-3" });
    const { createObservationEvalSchedulerDeps } =
      await import("../createSchedulerDeps");

    await createObservationEvalSchedulerDeps().upsertJobExecution(
      jobExecutionParams("exp-1"),
    );

    expect(upsertJobExecution).toHaveBeenCalledWith({
      where: { id: "job-3", projectId: "project-1" },
      create: expect.objectContaining({
        jobInputExperimentId: "exp-1",
        status: JobExecutionStatus.PENDING,
      }),
      // The evaluated target never changes experiment, so it is write-once.
      update: { status: JobExecutionStatus.PENDING },
    });
  });

  it("persists a null experiment id outside experiment runs", async () => {
    upsertJobExecution.mockResolvedValue({ id: "job-3" });
    const { createObservationEvalSchedulerDeps } =
      await import("../createSchedulerDeps");

    await createObservationEvalSchedulerDeps().upsertJobExecution(
      jobExecutionParams(null),
    );

    expect(upsertJobExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ jobInputExperimentId: null }),
      }),
    );
  });
});
