-- AlterTable
ALTER TABLE "candidates" ADD COLUMN     "mergedIntoId" TEXT;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
