import { describe, it, expect } from "vitest";
import { normalizeEmail, normalizeName, normalizePhone } from "../../src/domain/dedupe/normalize.js";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
  });
});

describe("normalizePhone", () => {
  it("normalizes differently-formatted US numbers to the same E.164 value", () => {
    expect(normalizePhone("(415) 555-0100")).toBe("+14155550100");
    expect(normalizePhone("415-555-0100")).toBe("+14155550100");
    expect(normalizePhone("415.555.0100")).toBe("+14155550100");
  });

  it("returns null for unparseable or missing input rather than storing garbage", () => {
    expect(normalizePhone("not-a-phone")).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("normalizeName", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeName("  Jane   O'Doe-Smith! ")).toBe("jane odoesmith");
  });
});
