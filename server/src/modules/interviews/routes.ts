import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/requireAuth.js";
import * as controller from "./controller.js";

export const interviewsRouter = Router();

interviewsRouter.use(requireAuth);

const canManage = requireRole("ADMIN", "RECRUITER", "HIRING_MANAGER");

interviewsRouter.post("/", canManage, asyncHandler(controller.scheduleInterviewHandler));
interviewsRouter.get("/", asyncHandler(controller.listInterviewsHandler));
interviewsRouter.post("/:interviewId/cancel", canManage, asyncHandler(controller.cancelInterviewHandler));
interviewsRouter.post("/:interviewId/scorecards", asyncHandler(controller.submitScorecardHandler));
interviewsRouter.get("/:interviewId/scorecards", asyncHandler(controller.listScorecardsHandler));
