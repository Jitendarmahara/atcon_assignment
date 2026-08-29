import { z } from "zod";

export const applySchema = z.object({
  fullName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
});
export type ApplyInput = z.infer<typeof applySchema>;
