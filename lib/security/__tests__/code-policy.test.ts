import { describe, expect, it } from "vitest";

import { ALLOWED_PYTHON_MODULES, validateGeneratedCode } from "../code-policy";

const CLEAN_CODE = `
import duckdb
import json
from statistics import mean

con = duckdb.connect("snapshot.db")
rows = con.execute("SELECT region, SUM(amount) AS total FROM orders GROUP BY region").fetchall()
print(json.dumps({"columns": ["region", "total"], "rows": rows}))
`;

describe("validateGeneratedCode — allowances", () => {
  it("approves clean analysis code using allowlisted modules", () => {
    const decision = validateGeneratedCode(CLEAN_CODE);
    expect(decision.allowed).toBe(true);
    expect(decision.violations).toEqual([]);
  });

  it("allows every module on the published allowlist", () => {
    for (const moduleName of ALLOWED_PYTHON_MODULES) {
      const decision = validateGeneratedCode(`import ${moduleName}\n`);
      expect(decision.allowed, moduleName).toBe(true);
    }
  });

  it("allows module aliases and from-imports of allowed modules", () => {
    expect(
      validateGeneratedCode("import duckdb as db\nfrom math import sqrt\n").allowed
    ).toBe(true);
  });
});

describe("validateGeneratedCode — rejections", () => {
  const rejects = (code: string, rule: string) => {
    const decision = validateGeneratedCode(code);
    expect(decision.allowed, code).toBe(false);
    expect(decision.violations.some((v) => v.rule === rule), code).toBe(true);
    return decision;
  };

  it("rejects non-allowlisted imports with line numbers", () => {
    const decision = rejects("import os\n", "disallowed-module");
    expect(decision.violations[0].line).toBe(1);
    rejects("import requests\n", "disallowed-module");
    rejects("from urllib.request import urlopen\n", "disallowed-module");
  });

  it("rejects dynamic execution and introspection", () => {
    rejects("eval('1+1')\n", "dynamic-eval");
    rejects("exec(code)\n", "dynamic-eval");
    rejects("compile(src, 'x', 'exec')\n", "dynamic-eval");
    rejects("__import__('os')\n", "dynamic-eval");
    rejects("getattr(obj, 'name')\n", "host-introspection");
    rejects("globals()['os']\n", "host-introspection");
  });

  it("rejects filesystem and environment access", () => {
    rejects("open('/etc/passwd')\n", "filesystem-access");
    rejects("input()\n", "filesystem-access");
    rejects("breakpoint()\n", "filesystem-access");
    rejects("import pathlib\npathlib.Path('.')\n", "disallowed-module");
    rejects("import os\nos.environ\n", "disallowed-module");
    rejects("key = environ['KEY']\n", "env-access");
  });

  it("rejects network-capable modules referenced without import", () => {
    rejects("socket.socket()\n", "restricted-module");
    rejects("subprocess.run('ls')\n", "restricted-module");
    rejects("importlib.import_module('os')\n", "restricted-module");
  });

  it("rejects DuckDB network and export surfaces", () => {
    rejects("con.execute(\"SELECT * FROM read_csv_auto('https://evil.example/x')\")\n", "duckdb-network");
    rejects("con.execute(\"INSTALL httpfs\")\n", "duckdb-network");
    rejects("con.execute(\"ATTACH 'amplified.db' AS exfil\")\n", "duckdb-attach");
    rejects("con.execute(\"COPY orders TO '/tmp/out.csv'\")\n", "duckdb-export");
    rejects("con.execute(\"EXPORT DATABASE 'out'\")\n", "duckdb-export");
    rejects("con.execute(\"CREATE SECRET my_secret\")\n", "duckdb-secret");
  });

  it("does not false-positive on ordinary Python words", () => {
    expect(
      validateGeneratedCode("weights = load()\ndataset = 'install day totals'\n").allowed
    ).toBe(true);
  });

  it("ignores matches inside comments", () => {
    expect(validateGeneratedCode("# import os for testing\nimport duckdb\n").allowed).toBe(
      true
    );
  });
});
