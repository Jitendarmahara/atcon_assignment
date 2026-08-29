import { z } from "zod";
import { paginationSchema } from "../../lib/pagination.js";

export const createCandidateSchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
});
export type CreateCandidateInput = z.infer<typeof createCandidateSchema>;

export const updateCandidateSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  phone: z.string().max(40).optional(),
});
export type UpdateCandidateInput = z.infer<typeof updateCandidateSchema>;

export const listCandidatesQuerySchema = paginationSchema.extend({
  q: z.string().max(200).optional(),
});

export const mergeCandidateSchema = z.object({
  duplicateId: z.string().uuid(),
});
export type MergeCandidateInput = z.infer<typeof mergeCandidateSchema>;
