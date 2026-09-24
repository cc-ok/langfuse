import { JobExecutionStatus, type PrismaClient } from "@prisma/client";
import type {
  EvaluatorExecutionCountsByEvaluatorId,
  EvaluatorExecutionStatusCount,
} from "../../features/evals/evalConfigBlocking";

type EvaluatorExecutionStatusCountRecord = EvaluatorExecutionStatusCount & {
  evaluatorId: string;
};

export const getEvaluatorExecutionStatusCounts = async ({
  prisma,
  projectId,
  evaluatorIds,
}: {
  prisma: PrismaClient;
  projectId: string;
  evaluatorIds: string[];
}): Promise<EvaluatorExecutionStatusCountRecord[]> => {
  if (evaluatorIds.length === 0) {
    return [];
  }

  const counts = await prisma.jobExecution.groupBy({
    where: {
      // We currently assume every job execution belongs to an evaluator job configuration.
      jobConfigurationId: { in: evaluatorIds },
      projectId,
    },
    by: ["status", "jobConfigurationId"],
    _count: true,
  });

  return counts.map((count) => ({
    evaluatorId: count.jobConfigurationId,
    status: count.status,
    count: count._count,
  }));
};

export const getEvaluatorExecutionStatusCountsByEvaluatorId = async ({
  prisma,
  projectId,
  evaluatorIds,
}: {
  prisma: PrismaClient;
  projectId: string;
  evaluatorIds: string[];
}): Promise<EvaluatorExecutionCountsByEvaluatorId> => {
  const counts = await getEvaluatorExecutionStatusCounts({
    prisma,
    projectId,
    evaluatorIds,
  });

  const countsByEvaluatorId = Object.fromEntries(
    evaluatorIds.map((evaluatorId) => [
      evaluatorId,
      [] as EvaluatorExecutionStatusCount[],
    ]),
  ) as EvaluatorExecutionCountsByEvaluatorId;

  for (const { evaluatorId, ...count } of counts) {
    countsByEvaluatorId[evaluatorId]?.push(count);
  }

  return countsByEvaluatorId;
};

/**
 * Counts evaluation job executions of an experiment run by status.
 *
 * Backed by the (project_id, job_input_experiment_id, status) index, so it only
 * touches the rows of that experiment run.
 */
export const getExperimentJobStatusCounts = async ({
  prisma,
  projectId,
  experimentId,
}: {
  prisma: PrismaClient;
  projectId: string;
  experimentId: string;
}): Promise<Array<{ status: JobExecutionStatus; count: number }>> => {
  const counts = await prisma.jobExecution.groupBy({
    where: {
      projectId,
      jobInputExperimentId: experimentId,
    },
    by: ["status"],
    _count: true,
  });

  return counts.map((count) => ({
    status: count.status,
    count: count._count,
  }));
};

/**
 * Cancels the not-yet-started evaluation jobs of an experiment run.
 *
 * Rows are kept so the evaluation log stays auditable; executors short-circuit
 * on terminal statuses, so a cancelled job never calls the evaluator. Jobs that
 * are already executing are not preempted and may still complete.
 */
export const cancelExperimentJobs = async ({
  prisma,
  projectId,
  experimentId,
}: {
  prisma: PrismaClient;
  projectId: string;
  experimentId: string;
}): Promise<number> => {
  const result = await prisma.jobExecution.updateMany({
    where: {
      projectId,
      jobInputExperimentId: experimentId,
      status: {
        in: [JobExecutionStatus.PENDING, JobExecutionStatus.DELAYED],
      },
    },
    data: {
      status: JobExecutionStatus.CANCELLED,
      endTime: new Date(),
    },
  });

  return result.count;
};
