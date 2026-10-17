import { describe, expect, it } from "vitest";

import { DEFAULT_REDACTION_OPTIONS, redactExecutionOutput } from "../redaction";

describe("redactExecutionOutput", () => {
  it("masks email addresses", () => {
    expect(redactExecutionOutput("owner: alice@acme.com")).toBe(
      "owner: [REDACTED:EMAIL]"
    );
  });

  it("masks API key and token shapes", () => {
    expect(redactExecutionOutput("key sk-liveabcdef1234567890")).toContain(
      "[REDACTED:SECRET]"
    );
    expect(redactExecutionOutput("token ghp_" + "a".repeat(24))).toContain(
      "[REDACTED:SECRET]"
    );
    expect(redactExecutionOutput("AKIAIOSFODNN7EXAMPLE")).toBe(
      "[REDACTED:SECRET]"
    );
    expect(
      redactExecutionOutput("Authorization: Bearer abcdefghijklmnopqrstuvwx")
    ).toContain("[REDACTED:SECRET]");
  });

  it("masks SSN and phone shapes and long digit runs", () => {
    expect(redactExecutionOutput("ssn 123-45-6789")).toBe("ssn [REDACTED:SSN]");
    expect(redactExecutionOutput("call 415-555-0123")).toBe(
      "call [REDACTED:PHONE]"
    );
    expect(redactExecutionOutput("account 4155550123")).toBe(
      "account [REDACTED:DIGITS]"
    );
  });

  it("leaves ordinary numbers and short values alone", () => {
    expect(redactExecutionOutput("revenue=123456 zip=94110 qty=12")).toBe(
      "revenue=123456 zip=94110 qty=12"
    );
  });

  it("strips control characters including ANSI escapes", () => {
    expect(redactExecutionOutput("\u001b[31merror\u001b[0m\nline2")).toBe(
      "[31merror[0m\nline2"
    );
  });

  it("truncates long output with a marker", () => {
    const text = "x".repeat(DEFAULT_REDACTION_OPTIONS.maxLength + 100);
    const result = redactExecutionOutput(text);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("[truncated, 100 character(s) omitted]");
  });

  it("returns empty string for non-string input", () => {
    expect(redactExecutionOutput(undefined as never)).toBe("");
  });
});
