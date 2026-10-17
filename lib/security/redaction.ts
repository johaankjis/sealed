/**
 * Redaction of raw execution output (stdout, stderr, logs).
 *
 * Security rule: unvalidated stdout/stderr/logs/files must never
 * be exposed to buyers. These helpers scrub the most common
 * identifying values and secret shapes before such text is
 * persisted or displayed anywhere outside the server, and cap
 * its length.
 */

export interface RedactionOptions {
  /** Maximum retained length; longer output is truncated with a marker. */
  maxLength: number;
}

export const DEFAULT_REDACTION_OPTIONS: RedactionOptions = {
  maxLength: 4000,
};

interface RedactionRule {
  pattern: RegExp;
  label: string;
}

const REDACTION_RULES: RedactionRule[] = [
  { pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, label: "EMAIL" },
  {
    // sk-..., ghp_/gho_..., AWS access keys, generic bearer-style tokens
    pattern: /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g,
    label: "SECRET",
  },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, label: "SSN" },
  { pattern: /\b\d{3}-\d{3}-\d{4}\b/g, label: "PHONE" },
  {
    // Runs of 7+ digits: account numbers, IDs, timestamps.
    pattern: /\d{7,}/g,
    label: "DIGITS",
  },
];

export function redactExecutionOutput(
  text: string,
  options: Partial<RedactionOptions> = {}
): string {
  const { maxLength } = { ...DEFAULT_REDACTION_OPTIONS, ...options };

  if (typeof text !== "string") {
    return "";
  }

  // Strip control characters except newline and tab so terminal
  // escape sequences and NUL bytes cannot travel with the log.
  let redacted = text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    ""
  );

  for (const { pattern, label } of REDACTION_RULES) {
    redacted = redacted.replace(pattern, `[REDACTED:${label}]`);
  }

  if (redacted.length > maxLength) {
    const omitted = redacted.length - maxLength;
    redacted = `${redacted.slice(0, maxLength)}\n[truncated, ${omitted} character(s) omitted]`;
  }

  return redacted;
}
