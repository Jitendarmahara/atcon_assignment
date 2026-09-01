import type { Request, Response } from "express";
import * as authService from "core/modules/auth/service.js";
import { inviteUserSchema, loginSchema, refreshSchema, registerSchema } from "./schema.js";
import { ApiError } from "core/lib/errors.js";

export async function registerHandler(req: Request, res: Response) {
  const input = registerSchema.parse(req.body);
  const result = await authService.register(input);
  res.status(201).json(result);
}

export async function loginHandler(req: Request, res: Response) {
  const input = loginSchema.parse(req.body);
  const result = await authService.login(input);
  res.status(200).json(result);
}

export async function refreshHandler(req: Request, res: Response) {
  const input = refreshSchema.parse(req.body);
  const result = await authService.refresh(input.refreshToken);
  res.status(200).json(result);
}

export async function meHandler(req: Request, res: Response) {
  if (!req.auth) throw ApiError.unauthorized();
  const user = await authService.me(req.auth.userId);
  res.status(200).json(user);
}

export async function logoutHandler(req: Request, res: Response) {
  if (!req.auth) throw ApiError.unauthorized();
  await authService.logout(req.auth.userId);
  res.status(204).send();
}

export async function inviteUserHandler(req: Request, res: Response) {
  if (!req.auth) throw ApiError.unauthorized();
  const input = inviteUserSchema.parse(req.body);
  const user = await authService.inviteUser(req.auth.orgId, req.auth.userId, input);
  res.status(201).json(user);
}

export async function listUsersHandler(req: Request, res: Response) {
  if (!req.auth) throw ApiError.unauthorized();
  const users = await authService.listOrgUsers(req.auth.orgId);
  res.status(200).json({ items: users });
}
