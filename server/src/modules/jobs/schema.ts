import { z } from "zod";
import { paginationSchema } from "core/lib/pagination.js";

export const employmentTypeEnum = z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERNSHIP"]);
export const jobStatusEnum = z.enum(["DRAFT", "PUBLISHED", "CLOSED"]);
export const stageKindEnum = z.enum(["APPLIED", "SCREEN", "INTERVIEW", "OFFER", "HIRED", "REJECTED"]);

export const createJobSchema = z.object({
  title: z.string().min(2).max(200),
  description: z.string().min(1).max(20_000),
  department: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
  employmentType: employmentTypeEnum.default("FULL_TIME"),
  openings: z.coerce.number().int().min(1).max(1000).default(1),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const updateJobSchema = createJobSchema.partial();
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

export const listJobsQuerySchema = paginationSchema.extend({
  status: jobStatusEnum.optional(),
});

export const createStageSchema = z.object({
  name: z.string().min(1).max(80),
  kind: stageKindEnum,
  order: z.coerce.number().int().min(0),
  slaDays: z.coerce.number().int().min(1).max(365).nullable().optional(),
});
export type CreateStageInput = z.infer<typeof createStageSchema>;

export const updateStageSchema = createStageSchema.partial().omit({ order: true });
export type UpdateStageInput = z.infer<typeof updateStageSchema>;

export const reorderStagesSchema = z.object({
  order: z.array(z.string().uuid()).min(1), // stage ids, in the desired order
});
export type ReorderStagesInput = z.infer<typeof reorderStagesSchema>;
