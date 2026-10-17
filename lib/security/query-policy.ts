/**
 * Validation for buyer-submitted questions, applied at the API
 * boundary before a job is created or handed to code generation.
 *
 * This is input hygiene plus a heuristic block on requests that
 * are obviously asking for raw data dumps. The real enforcement
 * of aggregate-only output lives in output-policy.ts; these
 * checks exist so garbage and dump requests fail early and cheap.
 */

export interface QuestionValidation {
  ok: boolean;
  reason?: string;
  /** Trimmed, control-character-free question, present when ok. */
  sanitized?: string;
}

export interface QuestionPolicyOptions {
  maxLength: number;
}

export const DEFAULT_QUESTION_POLICY_OPTIONS: QuestionPolicyOptions = {
  maxLength: 2000,
};

const DUMP_REQUEST_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(all|every)\s+rows?\b/i, label: "all rows" },
  { pattern: /\b(all|every)\s+(records?|entries|listings)\b/i, label: "all records" },
  {
    pattern: /\b(raw|full|entire|whole|complete)\s+(data(set)?|records?|rows?|table)\b/i,
    label: "full dataset",
  },
  {
    pattern: /\b(dump|export|download|extract)\s+(the\s+)?(data(set)?|table|rows?|records?|csv)\b/i,
    label: "data export",
  },
  { pattern: /\blist\s+(of\s+)?(all|every)\b/i, label: "enumerate everything" },
];

export function validateQuestion(
  raw: string,
  options: Partial<QuestionPolicyOptions> = {}
): QuestionValidation {
  const { maxLength } = { ...DEFAULT_QUESTION_POLICY_OPTIONS, ...options };

  if (typeof raw !== "string") {
    return { ok: false, reason: "question must be a string" };
  }
  if (raw.includes("\u0000")) {
    return { ok: false, reason: "question contains a NUL byte" };
  }

  const sanitized = raw
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (sanitized.length === 0) {
    return { ok: false, reason: "question is empty" };
  }
  if (sanitized.length > maxLength) {
    return {
      ok: false,
      reason: `question is ${sanitized.length} characters, limit is ${maxLength}`,
    };
  }

  for (const { pattern, label } of DUMP_REQUEST_PATTERNS) {
    if (pattern.test(sanitized)) {
      return {
        ok: false,
        reason: `question appears to request a raw data export (${label}); ` +
          `only aggregated insights are supported`,
      };
    }
  }

  return { ok: true, sanitized };
}
