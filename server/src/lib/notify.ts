import { prisma } from "./prisma.js";
import { publishOrgEvent } from "./pubsub.js";

async function pushLive(orgId: string, userIds: string[]) {
  // One event per addressed user (not one broadcast) - the notification
  // bell is per-user, and the SSE handler only forwards a payload with a
  // userId to the matching connection (see modules/realtime/stream.ts).
  await Promise.all(userIds.map((userId) => publishOrgEvent(orgId, { type: "notification.created", payload: { userId } })));
}

// In-app notification fan-out to every recruiting-side user in an org
// (ADMIN/RECRUITER/HIRING_MANAGER - interviewers only get scheduling-related
// notices, sent directly by the interview module).
export async function notifyOrgRecruiters(orgId: string, type: string, payload: unknown) {
  const users = await prisma.user.findMany({
    where: { orgId, role: { in: ["ADMIN", "RECRUITER", "HIRING_MANAGER"] } },
    select: { id: true },
  });
  if (users.length === 0) return;
  await prisma.notification.createMany({
    data: users.map((u) => ({ orgId, userId: u.id, type, payload: payload as never })),
  });
  await pushLive(orgId, users.map((u) => u.id));
}

export async function notifyUsers(orgId: string, userIds: string[], type: string, payload: unknown) {
  if (userIds.length === 0) return;
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({ orgId, userId, type, payload: payload as never })),
  });
  await pushLive(orgId, userIds);
}
