import type { Request, Response } from "express";
import * as candidateAuthService from "core/modules/candidateAuth/service.js";
import {
  candidateForgotPasswordSchema,
  candidateLoginSchema,
  candidateRefreshSchema,
  candidateRegisterSchema,
  candidateResetPasswordSchema,
} from "./schema.js";
import { ApiError } from "core/lib/errors.js";

export async function registerHandler(req: Request, res: Response) {
  const input = candidateRegisterSchema.parse(req.body);
  const result = await candidateAuthService.register(input);
  res.status(201).json(result);
}

export async function loginHandler(req: Request, res: Response) {
  const input = candidateLoginSchema.parse(req.body);
  const result = await candidateAuthService.login(input);
  res.status(200).json(result);
}

export async function refreshHandler(req: Request, res: Response) {
  const input = candidateRefreshSchema.parse(req.body);
  const result = await candidateAuthService.refresh(input.refreshToken);
  res.status(200).json(result);
}

export async function meHandler(req: Request, res: Response) {
  if (!req.candidateAuth) throw ApiError.unauthorized();
  const account = await candidateAuthService.me(req.candidateAuth.candidateAccountId);
  res.status(200).json(account);
}

export async function logoutHandler(req: Request, res: Response) {
  if (!req.candidateAuth) throw ApiError.unauthorized();
  await candidateAuthService.logout(req.candidateAuth.candidateAccountId);
  res.status(204).send();
}

export async function forgotPasswordHandler(req: Request, res: Response) {
  const input = candidateForgotPasswordSchema.parse(req.body);
  await candidateAuthService.forgotPassword(input);
  // Always 202 regardless of whether the email is registered - see
  // service.ts's forgotPassword() comment.
  res.status(202).json({ message: "If an account exists for that email, a reset link has been sent." });
}

export async function resetPasswordHandler(req: Request, res: Response) {
  const input = candidateResetPasswordSchema.parse(req.body);
  await candidateAuthService.resetPassword(input);
  res.status(204).send();
}
