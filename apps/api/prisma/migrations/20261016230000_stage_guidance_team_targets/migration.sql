-- Stage guidance: what a rep should do to move a deal out of the stage.
ALTER TABLE "PipelineStage" ADD COLUMN "guidance" TEXT NOT NULL DEFAULT '';

-- Team targets.
ALTER TABLE "SalesTarget" ADD COLUMN "teamId" UUID;
CREATE INDEX "SalesTarget_workspaceId_teamId_periodStart_idx" ON "SalesTarget"("workspaceId", "teamId", "periodStart");
ALTER TABLE "SalesTarget" ADD CONSTRAINT "SalesTarget_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
