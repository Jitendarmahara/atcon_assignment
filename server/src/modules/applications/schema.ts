import { z } from "zod";
import { paginationSchema } from "core/lib/pagination.js";

export const createApplicationSchema = z.object({
  candidateId: z.string().uuid(),
  jobId: z.string().uuid(),
  source: z.string().max(60).default("careers_site"),
});
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export const transitionApplicationSchema = z.object({
  toStageId: z.string().uuid(),
  reason: z.string().max(1000).optional(),
});
export type TransitionApplicationInput = z.infer<typeof transitionApplicationSchema>;

export const listApplicationsQuerySchema = paginationSchema.extend({
  jobId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  status: z.enum(["ACTIVE", "HIRED", "REJECTED", "WITHDRAWN"]).optional(),
});
