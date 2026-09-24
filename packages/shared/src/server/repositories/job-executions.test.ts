import { describe, it, expect, vi } from "vitest";
import { JobExecutionStatus, type PrismaClient } from "@prisma/client";
import {
  cancelExperimentJobs,
  getExperimentJobStatusCounts,
} from "./job-executions";

const asPrisma = (jobExecution: unknown) =>
  ({ jobExecution }) as unknown as PrismaClient;

describe("experiment evaluation job repository", () => {
  describe("getExperimentJobStatusCounts", () => {
    it("groups job executions of one experiment by status", async () => {
      const groupBy = vi.fn().mockResolvedValue([
        { status: JobExecutionStatus.PENDING, _count: 2 },
        { status: JobExecutionStatus.COMPLETED, _count: 5 },
      ]);

      const result = await getExperimentJobStatusCounts({
        prisma: asPrisma({ groupBy }),
        projectId: "project-1",
        experimentId: "exp-1",
      });

      expect(groupBy).toHaveBeenCalledWith({
        where: { projectId: "project-1", jobInputExperimentId: "exp-1" },
        by: ["status"],
        _count: true,
      });
      expect(result).toEqual([
        { status: JobExecutionStatus.PENDING, count: 2 },
        { status: JobExecutionStatus.COMPLETED, count: 5 },
      ]);
    });

    it("returns an empty list when the experiment has no jobs", async () => {
      const groupBy = vi.fn().mockResolvedValue([]);

      const result = await getExperimentJobStatusCounts({
        prisma: asPrisma({ groupBy }),
        projectId: "project-1",
        experimentId: "exp-without-jobs",
      });

      expect(result).toEqual([]);
    });
  });

  describe("cancelExperimentJobs", () => {
    it("cancels only the not-yet-started jobs of the experiment", async () => {
      const updateMany = vi.fn().mockResolvedValue({ count: 3 });

      const cancelled = await cancelExperimentJobs({
        prisma: asPrisma({ updateMany }),
        projectId: "project-1",
        experimentId: "exp-1",
      });

      expect(cancelled).toBe(3);
      expect(updateMany).toHaveBeenCalledTimes(1);

      const args = updateMany.mock.calls[0][0];
      expect(args.where).toEqual({
        projectId: "project-1",
        jobInputExperimentId: "exp-1",
        status: {
          in: [JobExecutionStatus.PENDING, JobExecutionStatus.DELAYED],
        },
      });
      expect(args.data.status).toBe(JobExecutionStatus.CANCELLED);
      expect(args.data.endTime).toBeInstanceOf(Date);
    });

    it("reports zero when there is nothing left to cancel", async () => {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });

      const cancelled = await cancelExperimentJobs({
        prisma: asPrisma({ updateMany }),
        projectId: "project-1",
        experimentId: "exp-1",
      });

      expect(cancelled).toBe(0);
    });
  });
});
