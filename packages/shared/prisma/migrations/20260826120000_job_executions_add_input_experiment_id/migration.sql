-- Prisma does not automatically wrap PostgreSQL migrations in a transaction.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- AlterTable
ALTER TABLE "job_executions"
  ADD COLUMN IF NOT EXISTS "job_input_experiment_id" TEXT;

COMMIT;
