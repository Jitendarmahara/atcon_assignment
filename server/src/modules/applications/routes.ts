import { Router } from "express";
import { asyncHandler } from "core/lib/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/requireAuth.js";
import * as controller from "./controller.js";

export const applicationsRouter = Router();

applicationsRouter.use(requireAuth);

const canManage = requireRole("ADMIN", "RECRUITER", "HIRING_MANAGER");

applicationsRouter.post("/", canManage, asyncHandler(controller.createApplicationHandler));
applicationsRouter.get("/", asyncHandler(controller.listApplicationsHandler));
applicationsRouter.get("/:applicationId", asyncHandler(controller.getApplicationHandler));
applicationsRouter.get("/:applicationId/events", asyncHandler(controller.listStageEventsHandler));
applicationsRouter.post("/:applicationId/transition", canManage, asyncHandler(controller.transitionApplicationHandler));
