import { prisma } from "@langfuse/shared/src/db";
import {
  cancelExperimentJobs,
  getExperimentJobStatusCounts,
  type ApiAccessScope,
} from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { JOB_CONFIGURATION_AUDIT_LOG_RESOURCE_TYPE } from "@/src/features/evals/server/audit-log-resource-types";
import { type EvaluationJobCountsByStatusType } from "@/src/features/public-api/types/unstable-evaluation-jobs";

/**
 * Job status counts of one experiment run.
 *
 * Experiments without evaluation jobs are reported with all counts set to
 * zero; the endpoint deliberately does not validate that the experiment run
 * exists, as that would require reading the events table to answer a purely
 * informational question.
 */
export const getPublicExperimentEvaluationJobStatus = async (params: {
  projectId: string;
  experimentId: string;
}) => {
  const counts = await getExperimentJobStatusCounts({
    prisma,
    projectId: params.projectId,
    experimentId: params.experimentId,
  });

  const byStatus: EvaluationJobCountsByStatusType = {
    PENDING: 0,
    DELAYED: 0,
    COMPLETED: 0,
    ERROR: 0,
    CANCELLED: 0,
  };
  for (const { status, count } of counts) {
    byStatus[status] = count;
  }

  return { experimentId: params.experimentId, byStatus };
};

/**
 * Cancels the not-yet-started jobs of one experiment run and records the action
 * in the audit log.
 */
export const cancelPublicExperimentEvaluationJobs = async (params: {
  projectId: string;
  experimentId: string;
  auditScope: Pick<ApiAccessScope, "orgId" | "apiKeyId">;
}) => {
  const cancelled = await cancelExperimentJobs({
    prisma,
    projectId: params.projectId,
    experimentId: params.experimentId,
  });

  await auditLog({
    action: "cancel",
    resourceType: JOB_CONFIGURATION_AUDIT_LOG_RESOURCE_TYPE,
    resourceId: params.experimentId,
    projectId: params.projectId,
    orgId: params.auditScope.orgId,
    apiKeyId: params.auditScope.apiKeyId,
    after: { experimentId: params.experimentId, cancelled },
  });

  return { experimentId: params.experimentId, cancelled };
};
