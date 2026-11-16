import { runEvaluatorForPublicApi } from "@/src/features/public-api/server/evaluation/evaluatorRunApiService";
import {
  createUnstablePublicApiRoute,
  withUnstablePublicApiMiddlewares,
} from "@/src/features/public-api/server/unstable-public-api-route";
import {
  EvaluatorIdQuery,
  RunEvaluatorBody,
  RunEvaluatorResponse,
} from "@/src/features/public-api/types/evaluation/evaluators";

export default withUnstablePublicApiMiddlewares({
  POST: createUnstablePublicApiRoute({
    name: "Run Code Evaluator",
    action: "evaluator:CUD",
    querySchema: EvaluatorIdQuery,
    bodySchema: RunEvaluatorBody,
    responseSchema: RunEvaluatorResponse,
    fn: async ({ query, body, auth }) =>
      runEvaluatorForPublicApi({
        projectId: auth.scope.projectId,
        evaluatorId: query.evaluatorId,
        body,
      }),
  }),
});
