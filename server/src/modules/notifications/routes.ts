import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import * as controller from "./controller.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);
notificationsRouter.get("/", asyncHandler(controller.listNotificationsHandler));
notificationsRouter.post("/:notificationId/read", asyncHandler(controller.markReadHandler));
