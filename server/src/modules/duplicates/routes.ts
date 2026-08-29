import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/requireAuth.js";
import * as controller from "./controller.js";

export const duplicatesRouter = Router();

duplicatesRouter.use(requireAuth, requireRole("ADMIN", "RECRUITER", "HIRING_MANAGER"));

duplicatesRouter.get("/", asyncHandler(controller.listDuplicatesHandler));
duplicatesRouter.post("/:linkId/confirm", asyncHandler(controller.confirmDuplicateHandler));
duplicatesRouter.post("/:linkId/dismiss", asyncHandler(controller.dismissDuplicateHandler));
