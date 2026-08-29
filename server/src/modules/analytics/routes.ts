import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import * as controller from "./controller.js";

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

analyticsRouter.get("/time-to-hire", asyncHandler(controller.timeToHireHandler));
analyticsRouter.get("/funnel", asyncHandler(controller.funnelHandler));
analyticsRouter.get("/pipeline-health", asyncHandler(controller.pipelineHealthHandler));
analyticsRouter.get("/sources", asyncHandler(controller.sourcesHandler));
