// RFC 7807 problem+json error model, used uniformly across the API by errorHandler.ts.

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly detail?: string;
  readonly extra?: Record<string, unknown>;

  constructor(status: number, type: string, detail?: string, extra?: Record<string, unknown>) {
    super(detail ?? type);
    this.status = status;
    this.type = type;
    this.detail = detail;
    this.extra = extra;
  }

  static badRequest(detail: string, extra?: Record<string, unknown>) {
    return new ApiError(400, "bad-request", detail, extra);
  }
  static unauthorized(detail = "Authentication required") {
    return new ApiError(401, "unauthorized", detail);
  }
  static forbidden(detail = "Insufficient permissions") {
    return new ApiError(403, "forbidden", detail);
  }
  static notFound(detail = "Resource not found") {
    return new ApiError(404, "not-found", detail);
  }
  static conflict(detail: string, extra?: Record<string, unknown>) {
    return new ApiError(409, "conflict", detail, extra);
  }
  static unprocessable(detail: string, extra?: Record<string, unknown>) {
    return new ApiError(422, "unprocessable-entity", detail, extra);
  }
  static tooMany(detail = "Too many requests") {
    return new ApiError(429, "rate-limited", detail);
  }
  static internal(detail = "Internal server error") {
    return new ApiError(500, "internal-error", detail);
  }
}
