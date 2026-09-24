import { cancelPublicExperimentEvaluationJobs } from "@/src/features/public-api/server/evaluation/evaluationJobApiService";
import {
  createUnstablePublicApiRoute,
  withUnstablePublicApiMiddlewares,
} from "@/src/features/public-api/server/unstable-public-api-route";
import {
  PostEvaluationJobCancelBody,
  PostEvaluationJobCancelResponse,
} from "@/src/features/public-api/types/unstable-evaluation-jobs";

export default withUnstablePublicApiMiddlewares({
  POST: createUnstablePublicApiRoute({
    name: "Cancel Experiment Evaluation Jobs",
    action: "evaluationRule:CUD",
    bodySchema: PostEvaluationJobCancelBody,
    responseSchema: PostEvaluationJobCancelResponse,
    fn: async ({ body, auth }) =>
      cancelPublicExperimentEvaluationJobs({
        projectId: auth.scope.projectId,
        experimentId: body.experimentId,
        auditScope: auth.scope,
      }),
  }),
});
