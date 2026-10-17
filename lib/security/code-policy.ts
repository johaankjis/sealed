/**
 * Static policy checks applied to Claude-generated Python code
 * before it is ever handed to the CreateOS sandbox.
 *
 * This is defense-in-depth in front of sandbox isolation: the
 * generated code gets an allowlist of harmless analysis modules
 * and is rejected for anything that could reach the network,
 * the filesystem, the host environment, or external DuckDB
 * surfaces.
 */

export interface CodePolicyDecision {
  allowed: boolean;
  violations: CodePolicyViolation[];
}

export interface CodePolicyViolation {
  /** 1-based line number, or 0 when the violation is global. */
  line: number;
  rule: string;
  detail: string;
}

/** Only these modules may be imported by generated analysis code. */
export const ALLOWED_PYTHON_MODULES = new Set([
  "duckdb",
  "math",
  "statistics",
  "decimal",
  "datetime",
  "json",
  "re",
  "itertools",
  "collections",
]);

/** Bare tokens that must never appear in generated code. */
const BANNED_TOKEN_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "dynamic-eval", pattern: /\b(eval|exec|compile|__import__)\s*\(/ },
  { rule: "filesystem-access", pattern: /\b(open|input|breakpoint)\s*\(/ },
  { rule: "host-introspection", pattern: /\b(getattr|setattr|delattr|globals|locals|vars)\s*\(/ },
  { rule: "restricted-module", pattern: /\b(subprocess|socket|ctypes|pickle|shutil|multiprocessing|importlib|http|urllib|requests|ftplib|smtplib|telnetlib|asyncio|threading)\b/ },
  { rule: "restricted-module", pattern: /\b(os|sys|pathlib|glob|tempfile)\s*[.,]/ },
  { rule: "env-access", pattern: /\benviron\b/ },
];

/** DuckDB surfaces that reach outside the local snapshot. */
const DUCKDB_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "duckdb-network", pattern: /\b(https?|s3|gs|az):\/\//i },
  { rule: "duckdb-network", pattern: /\bhttpfs\b/i },
  // SQL keywords are matched case-sensitively so ordinary Python
  // words like `load()` or `attach` in prose do not false-positive;
  // sandbox isolation is the backstop for anything that slips past.
  { rule: "duckdb-network", pattern: /\b(INSTALL|LOAD)\b/ },
  { rule: "duckdb-attach", pattern: /\bATTACH\b/ },
  { rule: "duckdb-export", pattern: /\bCOPY\b[^;\n]*\bTO\b/ },
  { rule: "duckdb-export", pattern: /\bEXPORT\s+DATABASE\b/ },
  { rule: "duckdb-secret", pattern: /\b(CREATE\s+)?SECRET\b/i },
];

const IMPORT_RE = /^\s*(import\s+.+|from\s+[\w.]+\s+import\s+.+)\s*$/;

/** Strips `#` comments naively; generated code is simple and false positives only fail safe. */
function stripComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return hashIndex === -1 ? line : line.slice(0, hashIndex);
}

function moduleRootsFromImport(line: string): string[] {
  const names: string[] = [];
  const plainImport = line.match(/^\s*import\s+(.+)$/);
  if (plainImport) {
    for (const part of plainImport[1].split(",")) {
      const moduleName = part.trim().split(/\s+as\s+/)[0].trim();
      if (moduleName) {
        names.push(moduleName.split(".")[0]);
      }
    }
  }
  const fromImport = line.match(/^\s*from\s+([\w.]+)\s+import\s+/);
  if (fromImport) {
    names.push(fromImport[1].split(".")[0]);
  }
  return names;
}

export function validateGeneratedCode(code: string): CodePolicyDecision {
  const violations: CodePolicyViolation[] = [];

  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = stripComment(lines[i]);

    if (IMPORT_RE.test(line)) {
      for (const root of moduleRootsFromImport(line)) {
        if (!ALLOWED_PYTHON_MODULES.has(root)) {
          violations.push({
            line: lineNumber,
            rule: "disallowed-module",
            detail: `module "${root}" is not on the analysis allowlist`,
          });
        }
      }
    }

    for (const { rule, pattern } of BANNED_TOKEN_RULES) {
      const match = line.match(pattern);
      if (match) {
        violations.push({
          line: lineNumber,
          rule,
          detail: `banned construct: ${match[0].trim()}`,
        });
      }
    }

    for (const { rule, pattern } of DUCKDB_RULES) {
      const match = line.match(pattern);
      if (match) {
        violations.push({
          line: lineNumber,
          rule,
          detail: `restricted DuckDB surface: ${match[0].trim()}`,
        });
      }
    }
  }

  return { allowed: violations.length === 0, violations };
}
