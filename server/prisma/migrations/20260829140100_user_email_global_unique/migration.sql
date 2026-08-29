-- POST /auth/login takes only {email, password}, with no organization
-- selector. A per-org unique email (the previous constraint) let two
-- different orgs each register a user with the same email, which made
-- login's `findFirst({ where: { email } })` pick an arbitrary one of them.
-- Email is now globally unique so the login lookup is unambiguous.

-- DropIndex
DROP INDEX "users_orgId_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
