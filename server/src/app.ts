import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import swaggerUi from "swagger-ui-express";
// Named import for the same reason as ioredis - see lib/redis.ts.
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";
import { isShuttingDown } from "./lib/shutdownState.js";
import { requestId } from "./middleware/requestId.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./modules/auth/routes.js";
import { jobsRouter } from "./modules/jobs/routes.js";
import { candidatesRouter } from "./modules/candidates/routes.js";
import { duplicatesRouter } from "./modules/duplicates/routes.js";
import { applicationsRouter } from "./modules/applications/routes.js";
import { interviewsRouter } from "./modules/interviews/routes.js";
import { notificationsRouter } from "./modules/notifications/routes.js";
import { analyticsRouter } from "./modules/analytics/routes.js";
import { adminRouter } from "./modules/admin/routes.js";
import { publicRouter } from "./modules/public/routes.js";
import { realtimeStreamHandler } from "./modules/realtime/stream.js";
import { openApiDocument } from "./openapi.js";

export function createApp() {
  const app = express();

  // Behind a reverse proxy/load balancer (the normal production topology),
  // req.ip is the proxy's address unless this is set - which would put every
  // client in one rate-limit bucket and break IP-based abuse protection.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: env.NODE_ENV !== "test",
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (_req, res) => {
    // Fail readiness the instant shutdown starts, before draining even
    // begins - an orchestrator's readiness probe should pull this instance
    // out of rotation immediately, not wait for the drain to finish.
    if (isShuttingDown()) {
      res.status(503).json({ status: "not-ready", error: "shutting down" });
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      res.json({ status: "ready" });
    } catch (err) {
      res.status(503).json({ status: "not-ready", error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/docs.json", (_req, res) => res.json(openApiDocument));
  // Helmet's default CSP (script-src/style-src 'self' only) blocks Swagger
  // UI's inline bootstrap script and styles - relax it for this one
  // documentation-only path rather than weakening it for the whole API.
  // Mounted synchronously and in-order: a previous version lazy-loaded this
  // via a dynamic import().then(...), which always registered the route
  // *after* the catch-all 404 handler below had already been added to
  // Express's middleware stack - every request to /api/docs 404'd,
  // deterministically, regardless of how long the import actually took.
  app.use("/api/docs", (_req, res, next) => {
    res.removeHeader("Content-Security-Policy");
    next();
  });
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  const api = express.Router();
  api.use("/auth", authRouter);
  api.use("/jobs", jobsRouter);
  api.use("/candidates", candidatesRouter);
  api.use("/duplicates", duplicatesRouter);
  api.use("/applications", applicationsRouter);
  api.use("/interviews", interviewsRouter);
  api.use("/notifications", notificationsRouter);
  api.use("/analytics", analyticsRouter);
  api.use("/admin", adminRouter);
  api.use("/public", publicRouter);
  // Its own auth (token as a query param, not a header - see stream.ts) since
  // it's opened by the browser's native EventSource, which can't set headers.
  api.get("/realtime/stream", realtimeStreamHandler);
  app.use("/api/v1", api);

  app.use((_req, res) => {
    res.status(404).type("application/problem+json").json({ type: "not-found", title: "Route not found", status: 404 });
  });

  app.use(errorHandler);

  return app;
}
