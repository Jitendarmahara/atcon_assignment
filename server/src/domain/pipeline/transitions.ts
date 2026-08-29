import type { JobStage } from "@prisma/client";
import { ApiError } from "../../lib/errors.js";

export interface TransitionResult {
  isBackwardMove: boolean;
}

const TERMINAL_KINDS = new Set(["HIRED", "REJECTED"]);

// The declarative transition policy referenced in the architecture doc.
// Deliberately permissive about *which* forward/backward stage a recruiter
// can jump to (real hiring pipelines skip steps - fast-tracking a referral
// past a phone screen is normal) but strict about the handful of rules that
// actually protect data integrity:
//   - nothing moves once an application is in a terminal stage,
//   - HIRED is only reachable from an OFFER-kind stage,
//   - REJECTED is reachable from anywhere non-terminal, but requires a reason,
//   - every other move is allowed, and tagged as "backward" for the audit
//     trail if it moves to an earlier `order` than the current stage.
export function validateTransition(fromStage: JobStage, toStage: JobStage, reason?: string): TransitionResult {
  if (TERMINAL_KINDS.has(fromStage.kind)) {
    throw ApiError.unprocessable(`Application is already in a terminal stage (${fromStage.kind}) and cannot be moved`, {
      currentStage: fromStage.kind,
    });
  }

  if (toStage.id === fromStage.id) {
    throw ApiError.unprocessable("Application is already in this stage");
  }

  if (toStage.kind === "HIRED" && fromStage.kind !== "OFFER") {
    throw ApiError.unprocessable("Can only mark HIRED from an Offer-kind stage", {
      requiredFromKind: "OFFER",
      actualFromKind: fromStage.kind,
    });
  }

  if (toStage.kind === "REJECTED" && !reason?.trim()) {
    throw ApiError.unprocessable("A reason is required when rejecting a candidate");
  }

  const isBackwardMove = !TERMINAL_KINDS.has(toStage.kind) && toStage.order < fromStage.order;
  return { isBackwardMove };
}
