import { Router } from "express";
import { asyncHandler } from "core/lib/asyncHandler.js";
import { requireCandidateAuth } from "../../middleware/requireCandidateAuth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import * as controller from "./controller.js";

export const candidateAuthRouter = Router();

// Same window/shape as the recruiter authLimiter (modules/auth/routes.ts) -
// these are the unauthenticated, publicly reachable candidate-auth paths.
const candidateAuthLimiter = rateLimit({ windowSec: 60, max: 20, keyPrefix: "candidate-auth" });

candidateAuthRouter.post("/register", candidateAuthLimiter, asyncHandler(controller.registerHandler));
candidateAuthRouter.post("/login", candidateAuthLimiter, asyncHandler(controller.loginHandler));
candidateAuthRouter.post("/refresh", candidateAuthLimiter, asyncHandler(controller.refreshHandler));
candidateAuthRouter.post("/forgot-password", candidateAuthLimiter, asyncHandler(controller.forgotPasswordHandler));
candidateAuthRouter.post("/reset-password", candidateAuthLimiter, asyncHandler(controller.resetPasswordHandler));
candidateAuthRouter.get("/me", requireCandidateAuth, asyncHandler(controller.meHandler));
candidateAuthRouter.post("/logout", requireCandidateAuth, asyncHandler(controller.logoutHandler));
