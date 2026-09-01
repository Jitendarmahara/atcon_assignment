-- Closes a race condition in createOrGetCandidate(): the "reuse an existing
-- candidate with this email" check was check-then-act with no DB backstop,
-- so two concurrent requests (e.g. a double-clicked public apply) could each
-- pass the check and create two candidate rows with the same (orgId,
-- normalizedEmail). Application code now also resolves through
-- mergedIntoId before reusing a match, so a tombstoned candidate's email
-- slot correctly redirects new activity to the live merge survivor instead
-- of colliding with it.

-- DropIndex
DROP INDEX "candidates_orgId_normalizedEmail_idx";

-- CreateIndex
CREATE UNIQUE INDEX "candidates_orgId_normalizedEmail_key" ON "candidates"("orgId", "normalizedEmail");
