import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/requireAuth.js";
import { resumeUpload } from "../../middleware/upload.js";
import * as controller from "./controller.js";

export const candidatesRouter = Router();

candidatesRouter.use(requireAuth);

const canManageCandidates = requireRole("ADMIN", "RECRUITER", "HIRING_MANAGER");

candidatesRouter.post("/", canManageCandidates, asyncHandler(controller.createCandidateHandler));
candidatesRouter.get("/", asyncHandler(controller.listCandidatesHandler));
candidatesRouter.get("/:candidateId", asyncHandler(controller.getCandidateHandler));
candidatesRouter.patch("/:candidateId", canManageCandidates, asyncHandler(controller.updateCandidateHandler));
candidatesRouter.post("/:candidateId/resumes", canManageCandidates, resumeUpload.single("resume"), asyncHandler(controller.addResumeHandler));
candidatesRouter.post("/:candidateId/merge", canManageCandidates, asyncHandler(controller.mergeCandidateHandler));
candidatesRouter.post("/:candidateId/rescan-duplicates", canManageCandidates, asyncHandler(controller.rescanDuplicatesHandler));
