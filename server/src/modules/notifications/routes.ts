import { Router } from "express";
import { asyncHandler } from "core/lib/asyncHandler.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import * as controller from "./controller.js";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);
notificationsRouter.get("/", asyncHandler(controller.listNotificationsHandler));
notificationsRouter.get("/unread-count", asyncHandler(controller.unreadCountHandler));
notificationsRouter.post("/:notificationId/read", asyncHandler(controller.markReadHandler));
notificationsRouter.delete("/:notificationId", asyncHandler(controller.removeHandler));
