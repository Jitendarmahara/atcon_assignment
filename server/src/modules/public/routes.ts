import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { resumeUpload } from "../../middleware/upload.js";
import * as controller from "./controller.js";

export const publicRouter = Router();

// Unauthenticated by design - this is the public careers site. Rate limited
// per-IP since it's the one write path anyone on the internet can hit.
const applyLimiter = rateLimit({ windowSec: 60, max: 10, keyPrefix: "public-apply" });

publicRouter.get("/orgs/:orgSlug/jobs", asyncHandler(controller.listJobsHandler));
publicRouter.get("/orgs/:orgSlug/jobs/:jobSlug", asyncHandler(controller.getJobHandler));
publicRouter.post(
  "/orgs/:orgSlug/jobs/:jobSlug/apply",
  applyLimiter,
  resumeUpload.single("resume"),
  asyncHandler(controller.applyHandler),
);
