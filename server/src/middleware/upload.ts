import multer from "multer";
import { env } from "core/config/env.js";
import { ApiError } from "core/lib/errors.js";

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
]);

// Buffered in memory (resumes are small, and we hash + persist immediately
// in the storage adapter) rather than streamed to a temp file on disk.
export const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      // Must be an ApiError, not a plain Error - errorHandler.ts only
      // special-cases ApiError/ZodError/known Prisma codes, so a plain Error
      // thrown here previously fell through to a raw 500 instead of the
      // "clear error" ASSUMPTIONS.md documents for a rejected upload.
      cb(ApiError.badRequest("Only PDF and DOCX resumes are accepted"));
      return;
    }
    cb(null, true);
  },
});
