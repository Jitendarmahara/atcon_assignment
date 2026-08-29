import type { Request, Response } from "express";
import { ApiError } from "../../lib/errors.js";
import * as applicationsService from "./service.js";
import { createApplicationSchema, listApplicationsQuerySchema, transitionApplicationSchema } from "./schema.js";

function auth(req: Request) {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

export async function createApplicationHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = createApplicationSchema.parse(req.body);
  const application = await applicationsService.createApplication(orgId, input);
  res.status(201).json(application);
}

export async function listApplicationsHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const query = listApplicationsQuerySchema.parse(req.query);
  const page = await applicationsService.listApplications(orgId, query);
  res.status(200).json(page);
}

export async function getApplicationHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const application = await applicationsService.getApplication(orgId, req.params.applicationId!);
  res.status(200).json(application);
}

export async function listStageEventsHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const events = await applicationsService.listStageEvents(orgId, req.params.applicationId!);
  res.status(200).json({ items: events });
}

export async function transitionApplicationHandler(req: Request, res: Response) {
  const { orgId, userId } = auth(req);
  const input = transitionApplicationSchema.parse(req.body);
  const result = await applicationsService.transitionApplication(orgId, userId, req.params.applicationId!, input);
  res.status(200).json(result);
}
