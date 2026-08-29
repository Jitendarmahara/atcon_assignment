import multer from "multer";
import { env } from "../config/env.js";

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
      cb(new Error("Only PDF and DOCX resumes are accepted"));
      return;
    }
    cb(null, true);
  },
});
