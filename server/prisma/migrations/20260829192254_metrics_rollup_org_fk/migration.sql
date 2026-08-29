-- AddForeignKey
ALTER TABLE "metrics_rollups" ADD CONSTRAINT "metrics_rollups_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
