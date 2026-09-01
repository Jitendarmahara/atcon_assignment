import type { Job } from "bullmq";
import { prisma } from "../../lib/prisma.js";
import { sendEmail } from "../../lib/mailer.js";
import { notifyOrgRecruiters } from "../../lib/notify.js";
import { processInterviewReminder } from "./interviewReminder.js";
import type { ApplicationStageChangedPayload, ApplicationSubmittedPayload } from "../../events/types.js";

interface CandidatePasswordResetPayload {
  email: string;
  fullName: string;
  resetUrl: string;
}

// Single queue for everything that notifies a person - outbound email and
// the (delayed) interview reminder share a bottleneck (SMTP, fast, no
// external LLM dependency), dispatched by job name onto one worker pool.
export async function processNotifications(job: Job) {
  switch (job.name) {
    case "application-confirmation":
      return handleApplicationConfirmation(job as Job<ApplicationSubmittedPayload>);
    case "stage-changed-notify":
      return handleStageChanged(job as Job<ApplicationStageChangedPayload>);
    case "interview-invite":
      return handleInterviewInvite(job as Job<{ interviewId: string }>);
    case "candidate-password-reset":
      return handleCandidatePasswordReset(job as Job<CandidatePasswordResetPayload>);
    case "remind":
      return processInterviewReminder(job as Job<{ interviewId: string }>);
    default:
      // Forward-compatible no-op for a job name this build doesn't know about.
      return;
  }
}

async function handleApplicationConfirmation(job: Job<ApplicationSubmittedPayload>) {
  const { applicationId } = job.data;
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { candidate: true, job: true },
  });

  await sendEmail(
    application.candidate.email,
    `Application received: ${application.job.title}`,
    `<p>Hi ${application.candidate.fullName},</p><p>Thanks for applying to <strong>${application.job.title}</strong>. We'll be in touch soon.</p>`,
  );

  await notifyOrgRecruiters(application.job.orgId, "application.submitted", {
    applicationId,
    candidateName: application.candidate.fullName,
    jobTitle: application.job.title,
  });
}

async function handleStageChanged(job: Job<ApplicationStageChangedPayload>) {
  const { applicationId, toStageKind } = job.data;
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { candidate: true, job: true, currentStage: true },
  });

  if (toStageKind === "HIRED") {
    await sendEmail(
      application.candidate.email,
      `Congratulations - ${application.job.title}`,
      `<p>Hi ${application.candidate.fullName},</p><p>We're excited to offer you the ${application.job.title} role. Congratulations!</p>`,
    );
  } else if (toStageKind === "REJECTED") {
    await sendEmail(
      application.candidate.email,
      `Update on your application - ${application.job.title}`,
      `<p>Hi ${application.candidate.fullName},</p><p>Thank you for your interest in ${application.job.title}. We've decided to move forward with other candidates at this time.</p>`,
    );
  }

  await notifyOrgRecruiters(application.job.orgId, "application.stage_changed", {
    applicationId,
    candidateName: application.candidate.fullName,
    toStage: application.currentStage.name,
  });
}

async function handleInterviewInvite(job: Job<{ interviewId: string }>) {
  const interview = await prisma.interview.findUniqueOrThrow({
    where: { id: job.data.interviewId },
    // select, not include: true - this result never leaves the worker
    // process, but a panelist's full User row (passwordHash included) has
    // no reason to exist in memory here beyond the one field actually used.
    include: { application: { include: { candidate: true, job: true } }, panelists: { include: { user: { select: { email: true } } } } },
  });
  const when = interview.scheduledAt.toISOString();

  await sendEmail(
    interview.application.candidate.email,
    `Interview scheduled - ${interview.application.job.title}`,
    `<p>Your interview for ${interview.application.job.title} is scheduled for ${when} (${interview.mode}).</p>`,
  );

  for (const panelist of interview.panelists) {
    await sendEmail(
      panelist.user.email,
      `Interview panel: ${interview.application.candidate.fullName}`,
      `<p>You're on the interview panel for ${interview.application.candidate.fullName} (${interview.application.job.title}) at ${when}.</p>`,
    );
  }
}

async function handleCandidatePasswordReset(job: Job<CandidatePasswordResetPayload>) {
  const { email, fullName, resetUrl } = job.data;
  await sendEmail(
    email,
    "Reset your password",
    `<p>Hi ${fullName},</p><p>Click below to reset your password. This link expires in 30 minutes.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
  );
}
