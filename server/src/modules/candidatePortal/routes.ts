import { Router } from "express";
import { asyncHandler } from "core/lib/asyncHandler.js";
import { requireCandidateAuth } from "../../middleware/requireCandidateAuth.js";
import * as controller from "./controller.js";

export const candidatePortalRouter = Router();

candidatePortalRouter.get("/applications", requireCandidateAuth, asyncHandler(controller.listMyApplicationsHandler));
candidatePortalRouter.get(
  "/applications/:applicationId/timeline",
  requireCandidateAuth,
  asyncHandler(controller.getApplicationTimelineHandler),
);
candidatePortalRouter.get("/open-roles", requireCandidateAuth, asyncHandler(controller.listOpenRolesHandler));
candidatePortalRouter.get("/notifications", requireCandidateAuth, asyncHandler(controller.listRecentUpdatesHandler));
candidatePortalRouter.get("/notifications/unread-count", requireCandidateAuth, asyncHandler(controller.unreadUpdateCountHandler));
candidatePortalRouter.post("/notifications/mark-viewed", requireCandidateAuth, asyncHandler(controller.markUpdatesViewedHandler));
