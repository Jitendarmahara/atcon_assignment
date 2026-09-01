import type { Request, Response } from "express";
import { ApiError } from "core/lib/errors.js";
import * as candidatesService from "core/modules/candidates/service.js";
import { createCandidateSchema, listCandidatesQuerySchema, mergeCandidateSchema, updateCandidateSchema } from "./schema.js";

function auth(req: Request) {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

export async function createCandidateHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = createCandidateSchema.parse(req.body);
  const candidate = await candidatesService.createOrGetCandidate(orgId, input);
  res.status(201).json(candidate);
}

export async function listCandidatesHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const query = listCandidatesQuerySchema.parse(req.query);
  const page = await candidatesService.listCandidates(orgId, query);
  res.status(200).json(page);
}

export async function getCandidateHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const candidate = await candidatesService.getCandidate(orgId, req.params.candidateId!);
  res.status(200).json(candidate);
}

export async function updateCandidateHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = updateCandidateSchema.parse(req.body);
  const candidate = await candidatesService.updateCandidate(orgId, req.params.candidateId!, input);
  res.status(200).json(candidate);
}

export async function addResumeHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  if (!req.file) throw ApiError.badRequest("A resume file is required");
  const resume = await candidatesService.addResume(orgId, req.params.candidateId!, req.file);
  res.status(202).json(resume);
}

export async function rescanDuplicatesHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  await candidatesService.rescanDuplicates(orgId, req.params.candidateId!);
  res.status(202).json({ status: "queued" });
}

export async function mergeCandidateHandler(req: Request, res: Response) {
  const { orgId, userId } = auth(req);
  const input = mergeCandidateSchema.parse(req.body);
  const survivor = await candidatesService.mergeCandidates(orgId, userId, req.params.candidateId!, input.duplicateId);
  res.status(200).json(survivor);
}
