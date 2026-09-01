import type { Request, Response } from "express";
import * as publicService from "core/modules/public/service.js";
import { applySchema } from "./schema.js";

export async function listJobsHandler(req: Request, res: Response) {
  const jobs = await publicService.listPublishedJobs(req.params.orgSlug!);
  res.status(200).json({ items: jobs });
}

export async function getJobHandler(req: Request, res: Response) {
  const job = await publicService.getPublishedJob(req.params.orgSlug!, req.params.jobSlug!);
  res.status(200).json(job);
}

export async function applyHandler(req: Request, res: Response) {
  const input = applySchema.parse(req.body);
  const result = await publicService.apply(req.params.orgSlug!, req.params.jobSlug!, input, req.file);
  // 202: candidate + application are created synchronously, but resume
  // parsing and dedupe scanning happen asynchronously in the worker.
  res.status(202).json(result);
}
