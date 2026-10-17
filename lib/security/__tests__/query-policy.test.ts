import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUESTION_POLICY_OPTIONS,
  validateQuestion,
} from "../query-policy";

describe("validateQuestion — approvals", () => {
  it("accepts a normal question and returns a sanitized copy", () => {
    const result = validateQuestion("  What were total sales by region in Q1?  ");
    expect(result.ok).toBe(true);
    expect(result.sanitized).toBe("What were total sales by region in Q1?");
  });

  it("accepts aggregate-style phrasings that mention 'all' safely", () => {
    expect(validateQuestion("Revenue across all regions").ok).toBe(true);
    expect(validateQuestion("Show all sales rows grouped by month").ok).toBe(true);
  });

  it("strips control characters but keeps newlines as spaces", () => {
    const result = validateQuestion("Total revenue\u0007 by month\u000b");
    expect(result.ok).toBe(true);
    expect(result.sanitized).toBe("Total revenue by month");
  });
});

describe("validateQuestion — rejections", () => {
  it("rejects empty and whitespace-only questions", () => {
    expect(validateQuestion("").ok).toBe(false);
    expect(validateQuestion("   \n\t ").ok).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validateQuestion(42 as never).ok).toBe(false);
  });

  it("rejects NUL bytes outright", () => {
    expect(validateQuestion("sales\u0000by month").ok).toBe(false);
  });

  it("rejects over-length questions", () => {
    const result = validateQuestion("a".repeat(DEFAULT_QUESTION_POLICY_OPTIONS.maxLength + 1));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("limit is 2000");
  });

  it("rejects obvious raw-data dump requests", () => {
    const dumpRequests = [
      "Give me all rows from the customers table",
      "Export the dataset to a CSV",
      "I need the raw data please",
      "Show me every record you have",
      "list of all customers",
      "Download the table for offline analysis",
    ];
    for (const question of dumpRequests) {
      const result = validateQuestion(question);
      expect(result.ok, question).toBe(false);
      expect(result.reason, question).toContain("raw data export");
    }
  });
});
