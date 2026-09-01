import { Router } from "express";
import { asyncHandler } from "core/lib/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/requireAuth.js";
import { ApiError } from "core/lib/errors.js";
import { getQueueStatus } from "core/modules/admin/service.js";

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
