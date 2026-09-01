import type { Request, Response } from "express";
import * as candidatePortalService from "core/modules/candidatePortal/service.js";
import { ApiError } from "core/lib/errors.js";

export async function listMyApplicationsHandler(req: Request, res: Response) {
  if (!req.candidateAuth) throw ApiError.unauthorized();
  const items = await candidatePortalService.listMyApplications(req.candidateAuth.email);
  res.status(200).json({ items });
}

export async function getApplicationTimelineHandler(req: Request, res: Response) {
  if (!req.candidateAuth) throw ApiError.unauthorized();
  const result = await candidatePortalService.getApplicationTimeline(req.candidateAuth.email, req.params.applicationId!);
  res.status(200).json(result);
}

export async function listOpenRolesHandler(req: Request, res: Response) {
  if (!req.candidateAuth) throw ApiError.unauthorized();
  const items = await candidatePortalService.listOpenRoles(req.candidateAuth.email);
  res.status(200).json({ items });
}

export async function listRecentUpdatesHandler(req: Request, res: Response) {
  if (!req.candidateAuth) throw ApiError.unauthorized();
  const items = await candidatePortalService.listRecentUpdates(req.candidateAuth.email);
  res.status(200).json({ items });
}

export async function unreadUpdateCountHandler(req: Request, res: Response) {
  if (!req.candidateAuth) throw ApiError.unauthorized();
  const count = await candidatePortalService.getUnreadUpdateCount(req.candidateAuth.candidateAccountId, req.candidateAuth.email);
  res.status(200).json({ count });
}

export async function markUpdatesViewedHandler(req: Request, res: Response) {
  if (!req.candidateAuth) throw ApiError.unauthorized();
  await candidatePortalService.markUpdatesViewed(req.candidateAuth.candidateAccountId);
  res.status(204).send();
}
