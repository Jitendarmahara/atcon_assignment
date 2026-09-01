import { z } from "zod";

export const candidateRegisterSchema = z.object({
  fullName: z.string().min(1).max(120),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(200),
});
export type CandidateRegisterInput = z.infer<typeof candidateRegisterSchema>;

export const candidateLoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});
export type CandidateLoginInput = z.infer<typeof candidateLoginSchema>;

export const candidateRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type CandidateRefreshInput = z.infer<typeof candidateRefreshSchema>;

export const candidateForgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase(),
});
export type CandidateForgotPasswordInput = z.infer<typeof candidateForgotPasswordSchema>;

export const candidateResetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});
export type CandidateResetPasswordInput = z.infer<typeof candidateResetPasswordSchema>;
