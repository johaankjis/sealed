export type ResultValue = string | number | null;

export interface ExecutionResult {
  columns: string[];
  rows: Array<Record<string, ResultValue>>;
  groupSizes?: number[];
}

export interface ApprovedResult {
  summary: string;
  columns: string[];
  rows: Array<Record<string, ResultValue>>;
  chartType: "bar" | "line" | "none";
}

export interface ValidationDecision {
  approved: boolean;
  reason?: string;
  result?: ApprovedResult;
}

export interface OutputPolicy {
  validate(
    result: ExecutionResult
  ): Promise<ValidationDecision>;
}
