-- Add nullable first, backfill from the JSON payload (every event type
-- defined in events/types.ts carries orgId), then enforce NOT NULL - the
-- straightforward "add required column with no default" migration Prisma
-- generates isn't valid against a non-empty table.
ALTER TABLE "outbox_events" ADD COLUMN "orgId" TEXT;

UPDATE "outbox_events" SET "orgId" = "payload"->>'orgId' WHERE "orgId" IS NULL;

ALTER TABLE "outbox_events" ALTER COLUMN "orgId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "outbox_events_orgId_idx" ON "outbox_events"("orgId");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
