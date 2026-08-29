import type { Request, Response } from "express";
import { ApiError } from "../../lib/errors.js";
import * as interviewsService from "./service.js";
import { createInterviewSchema, listInterviewsQuerySchema, submitScorecardSchema } from "./schema.js";

function auth(req: Request) {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

export async function scheduleInterviewHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const input = createInterviewSchema.parse(req.body);
  const interview = await interviewsService.scheduleInterview(orgId, input);
  res.status(201).json(interview);
}

export async function listInterviewsHandler(req: Request, res: Response) {
  const { orgId, userId, role } = auth(req);
  const query = listInterviewsQuerySchema.parse(req.query);
  const page = await interviewsService.listInterviews(orgId, { userId, role }, query);
  res.status(200).json(page);
}

export async function cancelInterviewHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const interview = await interviewsService.cancelInterview(orgId, req.params.interviewId!);
  res.status(200).json(interview);
}

export async function submitScorecardHandler(req: Request, res: Response) {
  const { orgId, userId, role } = auth(req);
  const input = submitScorecardSchema.parse(req.body);
  const scorecard = await interviewsService.submitScorecard(orgId, req.params.interviewId!, userId, role, input);
  res.status(201).json(scorecard);
}

export async function listScorecardsHandler(req: Request, res: Response) {
  const { orgId } = auth(req);
  const scorecards = await interviewsService.listScorecards(orgId, req.params.interviewId!);
  res.status(200).json({ items: scorecards });
}
