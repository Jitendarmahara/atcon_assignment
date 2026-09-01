import type { Request, Response } from "express";
import { ApiError } from "core/lib/errors.js";
import { paginationSchema } from "core/lib/pagination.js";
import * as duplicatesService from "core/modules/duplicates/service.js";

function auth(req: Request) {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

export async function listDuplicatesHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const query = paginationSchema.parse(req.query);
  const page = await duplicatesService.listDuplicates(orgId, query);
  res.status(200).json(page);
}

export async function confirmDuplicateHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const link = await duplicatesService.confirmDuplicate(orgId, req.params.linkId!);
  res.status(200).json(link);
}

export async function dismissDuplicateHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const link = await duplicatesService.dismissDuplicate(orgId, req.params.linkId!);
  res.status(200).json(link);
}
