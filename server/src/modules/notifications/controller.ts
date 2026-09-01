import type { Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "core/lib/errors.js";
import { paginationSchema } from "core/lib/pagination.js";
import * as notificationsService from "core/modules/notifications/service.js";

function auth(req: Request) {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

// Not z.coerce.boolean(): that coerces via JS's `Boolean(value)`, so any
// non-empty string - including the literal query string "false" - comes out
// `true`. A client calling GET /notifications?unreadOnly=false to mean "show
// everything" would silently get only-unread instead. Explicitly parsing the
// two accepted string values instead.
const listQuerySchema = paginationSchema.extend({
  unreadOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

export async function listNotificationsHandler(req: Request, res: Response) {
  const { orgId, userId } = auth(req);
  const query = listQuerySchema.parse(req.query);
  const page = await notificationsService.listNotifications(orgId, userId, query);
  res.status(200).json(page);
}

export async function unreadCountHandler(req: Request, res: Response) {
  const { orgId, userId } = auth(req);
  const count = await notificationsService.getUnreadCount(orgId, userId);
  res.status(200).json({ count });
}

export async function markReadHandler(req: Request, res: Response) {
  const { orgId, userId } = auth(req);
  const notification = await notificationsService.markRead(orgId, userId, req.params.notificationId!);
  res.status(200).json(notification);
}

export async function removeHandler(req: Request, res: Response) {
  const { orgId, userId } = auth(req);
  await notificationsService.remove(orgId, userId, req.params.notificationId!);
  res.status(204).send();
}
