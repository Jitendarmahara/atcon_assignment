import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/requireAuth.js";
import * as controller from "./controller.js";

export const jobsRouter = Router();

jobsRouter.use(requireAuth);

const canManageJobs = requireRole("ADMIN", "RECRUITER", "HIRING_MANAGER");

jobsRouter.post("/", canManageJobs, asyncHandler(controller.createJobHandler));
jobsRouter.get("/", asyncHandler(controller.listJobsHandler));
jobsRouter.get("/:jobId", asyncHandler(controller.getJobHandler));
jobsRouter.patch("/:jobId", canManageJobs, asyncHandler(controller.updateJobHandler));
jobsRouter.post("/:jobId/publish", canManageJobs, asyncHandler(controller.publishJobHandler));
jobsRouter.post("/:jobId/close", canManageJobs, asyncHandler(controller.closeJobHandler));

jobsRouter.get("/:jobId/stages", asyncHandler(controller.listStagesHandler));
jobsRouter.post("/:jobId/stages", canManageJobs, asyncHandler(controller.addStageHandler));
jobsRouter.patch("/:jobId/stages/reorder", canManageJobs, asyncHandler(controller.reorderStagesHandler));
jobsRouter.patch("/:jobId/stages/:stageId", canManageJobs, asyncHandler(controller.updateStageHandler));
jobsRouter.delete("/:jobId/stages/:stageId", canManageJobs, asyncHandler(controller.removeStageHandler));
