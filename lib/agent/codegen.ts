import Anthropic from "@anthropic-ai/sdk";
import type { ApprovedResult } from "../../contracts/results";
import type { DatasetDescriptor } from "./datasets";

export interface GeneratedAnalysis {
  code: string;
  summary: string;
  chartType: ApprovedResult["chartType"];
}

export interface GenerationRequest {
  question: string;
  dataset: DatasetDescriptor;
  /** Sanitized feedback from earlier failed attempts, oldest first. */
  previousFailures: string[];
}

export interface CodeGenerator {
  generate(request: GenerationRequest): Promise<GeneratedAnalysis>;
}

/**
 * How generated code talks to the sandbox. Must match what lib/sandbox
 * provides; change in one place if the sandbox runtime differs.
 */
export const DEFAULT_RUNTIME_CONTRACT = `- A DuckDB connection is pre-defined as the variable \`con\`. Do not create a new connection.
- The dataset is already loaded as a table; query it only through \`con.execute(sql).fetchall()\`.
- Assign the final answer to a variable named \`result\`: a dict {"columns": [...], "rows": [{...}], "groupSizes": [...]}.
  "rows" is a list of dicts keyed by column name; values must be strings, numbers, or None.
  "groupSizes" is required: for each row, the COUNT(*) of underlying records aggregated into it, taken from the same query.
- Do not print anything; stdout is discarded.`;

const SUBMIT_TOOL = "submit_analysis";

export function buildSystemPrompt(runtimeContract = DEFAULT_RUNTIME_CONTRACT) {
  return `You write Python analysis code for Sealed, a private-data insights marketplace.
A buyer asks a question about a private dataset they cannot see. Your code runs inside an isolated sandbox and only aggregate results may leave it.

Runtime:
${runtimeContract}

Rules:
- Only import duckdb, json, math, statistics, datetime, decimal. Usually no imports are needed.
- No file, network, OS, subprocess, eval/exec, or reflection access.
- Return aggregates only (COUNT, SUM, AVG, MIN, MAX, percentiles) grouped by low-cardinality dimensions.
- Never return identifiers, names, emails, phone numbers, addresses, or free-text columns, even if asked.
- Every group must include COUNT(*) so group sizes can be enforced, and filter with HAVING COUNT(*) >= 10.
- Do not add a COUNT column to "columns" unless the buyer asked for counts; report it in "groupSizes".
- Return at most 50 rows. Round floats to 2 decimals. Never name output columns with an _id suffix.
- If the question cannot be answered with aggregates, answer the closest safe aggregate question.

Submit your answer with the ${SUBMIT_TOOL} tool.`;
}

export function buildUserPrompt(request: GenerationRequest): string {
  const { dataset, question, previousFailures } = request;
  const columns = dataset.columns
    .map((c) => `  - ${c.name} (${c.type})${c.description ? `: ${c.description}` : ""}`)
    .join("\n");
  let prompt = `Dataset: ${dataset.name}
Description: ${dataset.description}
Table: ${dataset.tableName}
Columns:
${columns}

Buyer question: ${question}`;
  if (previousFailures.length > 0) {
    prompt += `\n\nPrevious attempts failed. Fix these problems:\n${previousFailures
      .map((f, i) => `${i + 1}. ${f}`)
      .join("\n")}`;
  }
  return prompt;
}

const submitTool: Anthropic.Tool = {
  name: SUBMIT_TOOL,
  description: "Submit the Python analysis code and how to present its result.",
  input_schema: {
    type: "object",
    properties: {
      code: { type: "string", description: "Complete Python program." },
      summary: {
        type: "string",
        description:
          "One or two sentences describing what the result shows, without specific numbers.",
      },
      chartType: { type: "string", enum: ["bar", "line", "none"] },
    },
    required: ["code", "summary", "chartType"],
  },
};

export function parseSubmission(input: unknown): GeneratedAnalysis {
  const value = input as Record<string, unknown> | null;
  if (
    !value ||
    typeof value.code !== "string" ||
    typeof value.summary !== "string" ||
    !["bar", "line", "none"].includes(value.chartType as string)
  ) {
    throw new Error("Model returned a malformed submission");
  }
  return {
    code: value.code,
    summary: value.summary,
    chartType: value.chartType as GeneratedAnalysis["chartType"],
  };
}

export interface ClaudeCodeGeneratorOptions {
  client?: Anthropic;
  model?: string;
  maxTokens?: number;
  runtimeContract?: string;
}

export class ClaudeCodeGenerator implements CodeGenerator {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private system: string;

  constructor(options: ClaudeCodeGeneratorOptions = {}) {
    // Reads ANTHROPIC_API_KEY from the server environment. Never pass it into
    // the sandbox.
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? process.env.SEALED_CLAUDE_MODEL ?? "claude-sonnet-5-5";
    this.maxTokens = options.maxTokens ?? 4096;
    this.system = buildSystemPrompt(options.runtimeContract);
  }

  async generate(request: GenerationRequest): Promise<GeneratedAnalysis> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: this.system,
      tools: [submitTool],
      tool_choice: { type: "tool", name: SUBMIT_TOOL },
      messages: [{ role: "user", content: buildUserPrompt(request) }],
    });
    const block = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_TOOL
    );
    if (!block) throw new Error("Model did not submit an analysis");
    return parseSubmission(block.input);
  }
}
