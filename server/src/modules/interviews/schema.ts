import { z } from "zod";
import { paginationSchema } from "core/lib/pagination.js";

export const createInterviewSchema = z.object({
  applicationId: z.string().uuid(),
  scheduledAt: z.coerce.date(),
  durationMin: z.coerce.number().int().min(15).max(480).default(45),
  mode: z.enum(["ONSITE", "VIDEO", "PHONE"]).default("VIDEO"),
  locationOrLink: z.string().max(500).optional(),
  panelistUserIds: z.array(z.string().uuid()).default([]),
});
export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;

export const listInterviewsQuerySchema = paginationSchema.extend({
  applicationId: z.string().uuid().optional(),
});

export const submitScorecardSchema = z.object({
  overall: z.enum(["STRONG_YES", "YES", "NO", "STRONG_NO"]),
  notes: z.string().max(5000).optional(),
  ratings: z
    .array(
      z.object({
        criterion: z.string().min(1).max(80),
        score: z.coerce.number().int().min(1).max(4),
        comment: z.string().max(1000).optional(),
      }),
    )
    .min(1, "At least one per-criterion rating is required"),
});
export type SubmitScorecardInput = z.infer<typeof submitScorecardSchema>;
