import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/requireAuth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import * as controller from "./controller.js";

export const authRouter = Router();

const authLimiter = rateLimit({ windowSec: 60, max: 20, keyPrefix: "auth" });

authRouter.post("/register", authLimiter, asyncHandler(controller.registerHandler));
authRouter.post("/login", authLimiter, asyncHandler(controller.loginHandler));
authRouter.post("/refresh", authLimiter, asyncHandler(controller.refreshHandler));
authRouter.get("/me", requireAuth, asyncHandler(controller.meHandler));
authRouter.post("/logout", requireAuth, asyncHandler(controller.logoutHandler));
authRouter.post("/users", requireAuth, requireRole("ADMIN"), asyncHandler(controller.inviteUserHandler));
// Listing org members is how a recruiter picks interview panelists - scoped
// to the same roles that can schedule interviews (interviews/routes.ts).
authRouter.get("/users", requireAuth, requireRole("ADMIN", "RECRUITER", "HIRING_MANAGER"), asyncHandler(controller.listUsersHandler));
