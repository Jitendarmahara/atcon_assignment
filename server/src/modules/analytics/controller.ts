import type { Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import * as analyticsService from "./service.js";

function auth(req: Request) {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

const optionalJobIdSchema = z.object({ jobId: z.string().uuid().optional() });
const requiredJobIdSchema = z.object({ jobId: z.string().uuid() });

export async function timeToHireHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const { jobId } = optionalJobIdSchema.parse(req.query);
  res.status(200).json(await analyticsService.timeToHire(orgId, jobId));
}

export async function funnelHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const { jobId } = requiredJobIdSchema.parse(req.query);
  res.status(200).json({ items: await analyticsService.funnel(orgId, jobId) });
}

export async function pipelineHealthHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const { jobId } = optionalJobIdSchema.parse(req.query);
  res.status(200).json(await analyticsService.pipelineHealth(orgId, jobId));
}

export async function sourcesHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  res.status(200).json({ items: await analyticsService.sourceEffectiveness(orgId) });
}
