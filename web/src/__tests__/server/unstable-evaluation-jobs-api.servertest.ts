import { v4 } from "uuid";
import { JobExecutionStatus } from "@prisma/client";
import { prisma } from "@langfuse/shared/src/db";
import { createOrgProjectAndApiKey } from "@langfuse/shared/src/server";
import {
  makeAPICall,
  makeZodVerifiedAPICall,
} from "@/src/__tests__/test-utils";
import {
  GetEvaluationJobStatusResponse,
  PostEvaluationJobCancelResponse,
} from "@/src/features/public-api/types/unstable-evaluation-jobs";

const STATUS_URL = "/api/public/unstable/evaluation-jobs/status";
const CANCEL_URL = "/api/public/unstable/evaluation-jobs/cancel";

describe("/api/public/unstable/evaluation-jobs API", () => {
  const orgIds: string[] = [];
  let auth: string;
  let projectId: string;

  beforeEach(async () => {
    const result = await createOrgProjectAndApiKey();
    auth = result.auth;
    projectId = result.projectId;
    orgIds.push(result.orgId);
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  /**
   * Creates one evaluation job per status. Neither the rule nor the trace is
   * relevant to the endpoints under test, so they are fixed/faked.
   */
  const createJobs = (experimentId: string, statuses: JobExecutionStatus[]) =>
    prisma.jobExecution.createMany({
      data: statuses.map((status) => ({
        id: `job-${v4()}`,
        projectId,
        jobConfigurationId: "rule-1",
        jobInputTraceId: `trace-${v4()}`,
        jobInputObservationId: `obs-${v4()}`,
        jobInputExperimentId: experimentId,
        status,
        startTime: new Date(),
      })),
    });

  const getStatus = (experimentId: string) =>
    makeZodVerifiedAPICall(
      GetEvaluationJobStatusResponse,
      "GET",
      `${STATUS_URL}?experimentId=${experimentId}`,
      undefined,
      auth,
    );

  const cancel = (experimentId: string) =>
    makeZodVerifiedAPICall(
      PostEvaluationJobCancelResponse,
      "POST",
      CANCEL_URL,
      { experimentId },
      auth,
    );

  describe("GET /api/public/unstable/evaluation-jobs/status", () => {
    it("reports every status as zero for an experiment without jobs", async () => {
      const { body } = await getStatus("exp-without-jobs");

      expect(body).toEqual({
        experimentId: "exp-without-jobs",
        byStatus: {
          PENDING: 0,
          DELAYED: 0,
          COMPLETED: 0,
          ERROR: 0,
          CANCELLED: 0,
        },
      });
    });

    it("counts the jobs of the experiment by status", async () => {
      const experimentId = `exp-${v4()}`;
      await createJobs(experimentId, [
        JobExecutionStatus.PENDING,
        JobExecutionStatus.DELAYED,
        JobExecutionStatus.COMPLETED,
        JobExecutionStatus.ERROR,
        JobExecutionStatus.CANCELLED,
      ]);

      const { body } = await getStatus(experimentId);

      expect(body.byStatus).toEqual({
        PENDING: 1,
        DELAYED: 1,
        COMPLETED: 1,
        ERROR: 1,
        CANCELLED: 1,
      });
    });

    it("does not count the jobs of another project", async () => {
      const experimentId = `exp-${v4()}`;
      const otherProject = await createOrgProjectAndApiKey();
      orgIds.push(otherProject.orgId);
      await prisma.jobExecution.create({
        data: {
          id: `job-${v4()}`,
          projectId: otherProject.projectId,
          jobConfigurationId: "rule-1",
          jobInputTraceId: `trace-${v4()}`,
          jobInputObservationId: `obs-${v4()}`,
          jobInputExperimentId: experimentId,
          status: JobExecutionStatus.PENDING,
          startTime: new Date(),
        },
      });

      const { body } = await getStatus(experimentId);

      expect(body.byStatus.PENDING).toBe(0);
    });

    it("rejects a missing experimentId", async () => {
      const { status } = await makeAPICall("GET", STATUS_URL, undefined, auth);

      expect(status).toBe(400);
    });
  });

  describe("POST /api/public/unstable/evaluation-jobs/cancel", () => {
    it("cancels only the jobs that have not started", async () => {
      const experimentId = `exp-${v4()}`;
      await createJobs(experimentId, [
        JobExecutionStatus.PENDING,
        JobExecutionStatus.DELAYED,
        JobExecutionStatus.COMPLETED,
        JobExecutionStatus.ERROR,
      ]);

      expect((await cancel(experimentId)).body).toEqual({
        experimentId,
        cancelled: 2,
      });

      const { body } = await getStatus(experimentId);

      expect(body.byStatus).toEqual({
        PENDING: 0,
        DELAYED: 0,
        COMPLETED: 1,
        ERROR: 1,
        CANCELLED: 2,
      });
    });

    it("is idempotent", async () => {
      const experimentId = `exp-${v4()}`;
      await createJobs(experimentId, [JobExecutionStatus.PENDING]);

      const first = await cancel(experimentId);
      const second = await cancel(experimentId);

      expect(first.body.cancelled).toBe(1);
      expect(second.body.cancelled).toBe(0);
    });

    it("leaves the jobs of another experiment untouched", async () => {
      const experimentId = `exp-${v4()}`;
      const otherExperimentId = `exp-${v4()}`;
      await createJobs(otherExperimentId, [JobExecutionStatus.PENDING]);

      await cancel(experimentId);

      const { body } = await getStatus(otherExperimentId);

      expect(body.byStatus.PENDING).toBe(1);
      expect(body.byStatus.CANCELLED).toBe(0);
    });

    it("rejects a missing experimentId", async () => {
      const { status } = await makeAPICall("POST", CANCEL_URL, {}, auth);

      expect(status).toBe(400);
    });
  });
});
