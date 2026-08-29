import type { Request, Response } from "express";
import { ApiError } from "../../lib/errors.js";
import * as jobsService from "./service.js";
import {
  createJobSchema,
  createStageSchema,
  listJobsQuerySchema,
  reorderStagesSchema,
  updateJobSchema,
  updateStageSchema,
} from "./schema.js";

function auth(req: Request) {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

export async function createJobHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = createJobSchema.parse(req.body);
  const job = await jobsService.createJob(orgId, input);
  res.status(201).json(job);
}

export async function listJobsHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const query = listJobsQuerySchema.parse(req.query);
  const page = await jobsService.listJobs(orgId, query);
  res.status(200).json(page);
}

export async function getJobHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const job = await jobsService.getJob(orgId, req.params.jobId!);
  res.status(200).json(job);
}

export async function updateJobHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = updateJobSchema.parse(req.body);
  const job = await jobsService.updateJob(orgId, req.params.jobId!, input);
  res.status(200).json(job);
}

export async function publishJobHandler(req: Request, res: Response) {
  const { orgId, userId } = auth(req);
  const job = await jobsService.publishJob(orgId, userId, req.params.jobId!);
  res.status(200).json(job);
}

export async function closeJobHandler(req: Request, res: Response) {
  const { orgId, userId } = auth(req);
  const job = await jobsService.closeJob(orgId, userId, req.params.jobId!);
  res.status(200).json(job);
}

export async function listStagesHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const stages = await jobsService.listStages(orgId, req.params.jobId!);
  res.status(200).json({ items: stages });
}

export async function addStageHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = createStageSchema.parse(req.body);
  const stage = await jobsService.addStage(orgId, req.params.jobId!, input);
  res.status(201).json(stage);
}

export async function updateStageHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = updateStageSchema.parse(req.body);
  const stage = await jobsService.updateStage(orgId, req.params.jobId!, req.params.stageId!, input);
  res.status(200).json(stage);
}

export async function removeStageHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  await jobsService.removeStage(orgId, req.params.jobId!, req.params.stageId!);
  res.status(204).send();
}

export async function reorderStagesHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = reorderStagesSchema.parse(req.body);
  const stages = await jobsService.reorderStages(orgId, req.params.jobId!, input);
  res.status(200).json({ items: stages });
}
