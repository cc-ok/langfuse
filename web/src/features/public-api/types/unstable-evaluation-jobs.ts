import { z } from "zod";

const jobCount = z.number().int().nonnegative();

/**
 * Counts of evaluation jobs per status. Every key is always present so clients
 * can compare against zero without handling missing entries.
 */
export const EvaluationJobCountsByStatus = z
  .object({
    PENDING: jobCount,
    DELAYED: jobCount,
    COMPLETED: jobCount,
    ERROR: jobCount,
    CANCELLED: jobCount,
  })
  .strict();

export type EvaluationJobCountsByStatusType = z.infer<
  typeof EvaluationJobCountsByStatus
>;

const experimentId = z.string().min(1);

export const GetEvaluationJobStatusQuery = z.object({ experimentId });

export const GetEvaluationJobStatusResponse = z
  .object({
    experimentId: z.string(),
    byStatus: EvaluationJobCountsByStatus,
  })
  .strict();

export const PostEvaluationJobCancelBody = z.object({ experimentId });

export const PostEvaluationJobCancelResponse = z
  .object({
    experimentId: z.string(),
    cancelled: z.number().int().nonnegative(),
  })
  .strict();
