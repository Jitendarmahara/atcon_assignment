import type { Job } from "bullmq";
import { logger } from "../../lib/logger.js";
import { purgeExpiredPasswordResetTokens } from "../../modules/candidateAuth/service.js";

// Nightly cleanup: an expired PasswordResetToken row can never be redeemed
// (rejected on expiresAt alone at reset time), so without this it just
// accumulates forever - one permanent row per "forgot password" click,
// used or not. See candidateAuth/service.ts for the deletion rule.
export async function processTokenCleanup(_job: Job) {
  const count = await purgeExpiredPasswordResetTokens();
  logger.info({ count }, "scheduled-maintenance: purged expired password reset tokens");
}
