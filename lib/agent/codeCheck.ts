// Cheap pre-flight check on generated Python before it is sent to the sandbox.
// This is defence in depth only: the CreateOS sandbox and the OutputPolicy are
// the real boundaries. It catches obvious model mistakes early and saves a
// sandbox round-trip.

const ALLOWED_IMPORTS = new Set(["duckdb", "json", "math", "statistics"]);

const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/\b__import__\b/, "dynamic import"],
  [/\b(eval|exec|compile)\s*\(/, "dynamic code execution"],
  [/\bopen\s*\(/, "file access"],
  [/\b(globals|locals|vars|getattr|setattr|delattr)\s*\(/, "reflection"],
  [/\b__\w+__\b/, "dunder access"],
  [/\b(read_csv|read_parquet|read_json|read_csv_auto)\b/i, "direct file read"],
  [/\b(COPY|EXPORT|ATTACH|INSTALL|LOAD)\b/, "DuckDB I/O statement"],
  [/\bhttps?:\/\//i, "network URL"],
];

export interface CodeCheckResult {
  ok: boolean;
  violations: string[];
}

export function checkGeneratedCode(code: string): CodeCheckResult {
  const violations: string[] = [];

  if (code.length > 20_000) violations.push("code too long");

  const importRe = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/gm;
  for (const match of code.matchAll(importRe)) {
    const modules = (match[1] ?? match[2])
      .split(",")
      .map((m) => m.trim().split(/\s+/)[0].split(".")[0])
      .filter(Boolean);
    for (const mod of modules) {
      if (!ALLOWED_IMPORTS.has(mod)) violations.push(`import not allowed: ${mod}`);
    }
  }

  for (const [pattern, label] of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) violations.push(`forbidden construct: ${label}`);
  }

  return { ok: violations.length === 0, violations };
}
