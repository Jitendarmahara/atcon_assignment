import type { Job } from "bullmq";
import { prisma } from "../../lib/prisma.js";
import { sendEmail } from "../../lib/mailer.js";

// Scheduled as a delayed job for (interview time - 24h) when the interview
// is created; see events/relay.ts. Re-checks status at fire time so a
// cancelled/rescheduled interview doesn't send a stale reminder.
export async function processInterviewReminder(job: Job<{ interviewId: string }>) {
  const interview = await prisma.interview.findUnique({
    where: { id: job.data.interviewId },
    include: { application: { include: { candidate: true, job: true } } },
  });
  if (!interview || interview.status !== "SCHEDULED") return;

  await sendEmail(
    interview.application.candidate.email,
    `Reminder: interview tomorrow for ${interview.application.job.title}`,
    `<p>This is a reminder that your interview is scheduled for ${interview.scheduledAt.toISOString()}.</p>`,
  );
}
