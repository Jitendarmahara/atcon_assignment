import { z } from "zod";

export const registerSchema = z.object({
  orgName: z.string().min(2).max(120),
  name: z.string().min(1).max(120),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const inviteUserSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(200),
  role: z.enum(["ADMIN", "RECRUITER", "HIRING_MANAGER", "INTERVIEWER"]),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
