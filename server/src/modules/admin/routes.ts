import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/requireAuth.js";
import { ApiError } from "../../lib/errors.js";
import { getQueueStatus } from "./service.js";

export const adminRouter = Router();

adminRouter.get(
  "/queues",
  requireAuth,
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw ApiError.unauthorized();
    res.status(200).json(await getQueueStatus(req.auth.orgId));
  }),
);
