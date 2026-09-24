import { getPublicExperimentEvaluationJobStatus } from "@/src/features/public-api/server/evaluation/evaluationJobApiService";
import {
  createUnstablePublicApiRoute,
  withUnstablePublicApiMiddlewares,
} from "@/src/features/public-api/server/unstable-public-api-route";
import {
  GetEvaluationJobStatusQuery,
  GetEvaluationJobStatusResponse,
} from "@/src/features/public-api/types/unstable-evaluation-jobs";

export default withUnstablePublicApiMiddlewares({
  GET: createUnstablePublicApiRoute({
    name: "Get Experiment Evaluation Job Status",
    action: "evalJobExecution:read",
    querySchema: GetEvaluationJobStatusQuery,
    responseSchema: GetEvaluationJobStatusResponse,
    fn: async ({ query, auth }) =>
      getPublicExperimentEvaluationJobStatus({
        projectId: auth.scope.projectId,
        experimentId: query.experimentId,
      }),
  }),
});
