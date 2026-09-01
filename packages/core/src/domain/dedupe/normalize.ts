
import { parsePhoneNumberWithError } from "libphonenumber-js";

// These are the deterministic match keys stored on Candidate. Computed once
// at write time (candidate create/update) rather than at query time, so the
// exact-match dedupe checks are plain indexed lookups.

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Best-effort E.164 formatting; defaults to a country hint since most demo
// data won't include one. Returns null for anything unparseable rather than
// storing garbage that would produce false-positive matches.
export function normalizePhone(phone: string | null | undefined, defaultCountry: "US" = "US"): string | null {
  if (!phone) return null;
  try {
    const parsed = parsePhoneNumberWithError(phone, defaultCountry);
    return parsed.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}
