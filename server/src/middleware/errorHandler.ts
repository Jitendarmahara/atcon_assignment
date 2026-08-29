import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

// Uniform RFC 7807 (application/problem+json) error body across the whole API.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error({ err, requestId: req.requestId }, "internal error");
    return res.status(err.status).type("application/problem+json").json({
      type: err.type,
      title: err.type,
      status: err.status,
      detail: err.detail,
      instance: req.originalUrl,
      requestId: req.requestId,
      ...(err.extra ?? {}),
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).type("application/problem+json").json({
      type: "validation-error",
      title: "Request validation failed",
      status: 400,
      detail: "One or more fields failed validation",
      instance: req.originalUrl,
      requestId: req.requestId,
      errors: err.flatten(),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).type("application/problem+json").json({
        type: "conflict",
        title: "Unique constraint violation",
        status: 409,
        detail: `A record with this ${(err.meta?.target as string[] | undefined)?.join(", ") ?? "value"} already exists`,
        instance: req.originalUrl,
        requestId: req.requestId,
      });
    }
    if (err.code === "P2025") {
      return res.status(404).type("application/problem+json").json({
        type: "not-found",
        title: "Resource not found",
        status: 404,
        instance: req.originalUrl,
        requestId: req.requestId,
      });
    }
    if (err.code === "P2003") {
      return res.status(409).type("application/problem+json").json({
        type: "conflict",
        title: "Referenced by another record",
        status: 409,
        detail: "This record can't be removed because other records still reference it",
        instance: req.originalUrl,
        requestId: req.requestId,
      });
    }
  }

  logger.error({ err, requestId: req.requestId }, "unhandled error");
  return res.status(500).type("application/problem+json").json({
    type: "internal-error",
    title: "Internal server error",
    status: 500,
    instance: req.originalUrl,
    requestId: req.requestId,
  });
}
