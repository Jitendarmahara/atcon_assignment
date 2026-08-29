import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";

export async function listNotifications(orgId: string, userId: string, params: { cursor?: string; limit: number; unreadOnly?: boolean }) {
  const rows = await prisma.notification.findMany({
    where: { orgId, userId, ...(params.unreadOnly ? { readAt: null } : {}) },
    orderBy: { id: "desc" },
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  return toPage(rows, params.limit);
}

export async function markRead(orgId: string, userId: string, notificationId: string) {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, orgId, userId } });
  if (!notification) throw ApiError.notFound("Notification not found");
  return prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
}
