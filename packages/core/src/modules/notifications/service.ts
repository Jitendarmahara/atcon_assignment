import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../lib/errors.js";
import { toPage } from "../../lib/pagination.js";

// Ordered by createdAt, with id as a tiebreaker for rows created in the same
// instant - NOT just `orderBy: { id: "desc" }` (the convention most other
// list endpoints in this app use for cursor pagination, per
// lib/pagination.ts's "uuid, effectively insertion-ordered enough" comment).
// That assumption is false for a plain v4 UUID (Prisma's default `uuid()`) -
// it's random, with zero correlation to creation order, so sorting by it
// alone doesn't produce "most recent first," it produces an arbitrary order
// that happens to be stable. Harmless for a candidates/jobs/applications
// list, where no one expects newest-first; a real, user-visible bug for a
// notification feed, where that's the entire point. Prisma's cursor
// pagination still works correctly with a compound orderBy - `cursor: { id }`
// resolves to that row's values for every orderBy field, not just `id`.
export async function listNotifications(orgId: string, userId: string, params: { cursor?: string; limit: number; unreadOnly?: boolean }) {
  const rows = await prisma.notification.findMany({
    where: { orgId, userId, ...(params.unreadOnly ? { readAt: null } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  });
  return toPage(rows, params.limit);
}

// Deliberately not derived from listNotifications()'s paginated result - a
// count based on `items.length` of a `limit`-capped list silently freezes
// once unread count exceeds that limit (every notification past the 10th
// arrives and is real, but the badge would never move again). A plain
// COUNT(*) has no such ceiling.
export async function getUnreadCount(orgId: string, userId: string): Promise<number> {
  return prisma.notification.count({ where: { orgId, userId, readAt: null } });
}

export async function markRead(orgId: string, userId: string, notificationId: string) {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, orgId, userId } });
  if (!notification) throw ApiError.notFound("Notification not found");
  return prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
}

export async function remove(orgId: string, userId: string, notificationId: string): Promise<void> {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, orgId, userId } });
  if (!notification) throw ApiError.notFound("Notification not found");
  await prisma.notification.delete({ where: { id: notificationId } });
}
