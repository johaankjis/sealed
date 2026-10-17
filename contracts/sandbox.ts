import type { ExecutionResult } from "./results";

export interface SandboxRuntime {
  prepareDataset(
    datasetId: string,
    datasetPath: string
  ): Promise<string>;

  execute(
    snapshotId: string,
    code: string
  ): Promise<ExecutionResult>;

  destroy(snapshotId: string): Promise<void>;
}

export interface SandboxExecutionOptions {
  timeoutMs: number;
  maxRetries: number;
}
