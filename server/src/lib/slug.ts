import { randomBytes } from "node:crypto";

// Slugify + a short random suffix so two jobs titled "Backend Engineer" never
// collide on the unique publicSlug column.
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const suffix = randomBytes(3).toString("hex");
  return `${base || "job"}-${suffix}`;
}
