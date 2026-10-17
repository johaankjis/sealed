import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { checkGeneratedCode } from "../codeCheck";
import { ClaudeCodeGenerator, buildUserPrompt, parseSubmission } from "../codegen";
import { dataset, safeCode } from "./fakes";

describe("checkGeneratedCode", () => {
  it("accepts the safe template", () => {
    expect(checkGeneratedCode(safeCode)).toEqual({ ok: true, violations: [] });
  });

  it.each([
    ["import os", "import not allowed: os"],
    ["from urllib.request import urlopen", "import not allowed: urllib"],
    ["import json, socket", "import not allowed: socket"],
    ["open('/etc/passwd')", "file access"],
    ["eval('1')", "dynamic code execution"],
    ["().__class__", "dunder access"],
    ["con.execute(\"COPY orders TO 'x.csv'\")", "DuckDB I/O statement"],
    ["con.execute(\"SELECT * FROM read_csv('/data/x')\")", "direct file read"],
  ])("blocks %s", (code, violation) => {
    const result = checkGeneratedCode(code);
    expect(result.ok).toBe(false);
    expect(result.violations.join()).toContain(violation);
  });
});

describe("prompting", () => {
  it("includes schema and prior failures but not the dataset path", () => {
    const prompt = buildUserPrompt({ question: "q?", dataset, previousFailures: ["bad column"] });
    expect(prompt).toContain("region (VARCHAR)");
    expect(prompt).toContain("1. bad column");
    expect(prompt).not.toContain(dataset.path);
  });

  it("validates tool input", () => {
    expect(() => parseSubmission({ code: "x", summary: "y", chartType: "pie" })).toThrow();
    expect(parseSubmission({ code: "x", summary: "y", chartType: "line" }).chartType).toBe("line");
  });
});

describe("ClaudeCodeGenerator", () => {
  it("forces the submit tool and parses its input", async () => {
    let params: Anthropic.MessageCreateParams | undefined;
    const client = {
      messages: {
        create: async (p: Anthropic.MessageCreateParams) => {
          params = p;
          return {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "submit_analysis",
                input: { code: safeCode, summary: "s", chartType: "bar" },
              },
            ],
          };
        },
      },
    } as unknown as Anthropic;

    const gen = new ClaudeCodeGenerator({ client, model: "test-model" });
    const result = await gen.generate({ question: "q", dataset, previousFailures: [] });
    expect(result.code).toBe(safeCode);
    expect(params?.model).toBe("test-model");
    expect(params?.tool_choice).toEqual({ type: "tool", name: "submit_analysis" });
  });
});
