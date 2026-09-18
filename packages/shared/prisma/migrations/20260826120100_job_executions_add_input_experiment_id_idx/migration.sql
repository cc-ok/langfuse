-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "job_executions_project_id_job_input_experiment_id_status_idx" ON "job_executions"("project_id", "job_input_experiment_id", "status");
