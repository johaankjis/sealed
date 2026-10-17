import { readFile } from "node:fs/promises";
import type { SandboxRuntime, SandboxExecutionOptions } from "../../contracts/sandbox";
import type { ExecutionResult } from "../../contracts/results";

// Structural subset of the documented SDK, injected by the server composition root.
// No SDK credentials or host environment are forwarded to the guest.
type RequestOptions = { timeoutMs: number; retry: false };
export interface CreateOSSandbox {
  id: string;
  files: { upload(path: string, data: string | ArrayBuffer): Promise<unknown> };
  runCommand(cmd: string, args: string[], options: RequestOptions): Promise<{
    result: { stdout: string; stderr: string; exit_code: number; error?: string };
  }>;
  pause(): Promise<unknown>;
  waitUntilPaused(): Promise<unknown>;
  fork(request: { ingress_enabled: false; egress: string[] }): Promise<CreateOSSandbox>;
  waitUntilRunning(): Promise<unknown>;
  destroy(): Promise<unknown>;
  waitUntilDestroyed(): Promise<unknown>;
}
export interface CreateOSClient {
  createSandbox(request: {
    shape: string; rootfs: string; ingress_enabled: false; egress: string[];
  }): Promise<CreateOSSandbox>;
}
export interface RuntimeConfig {
  client: CreateOSClient;
  shape: string;
  /** Trusted image with python3, DuckDB and GNU timeout preinstalled. */
  rootfs: string;
  egress: string[];
  /** Must fail unless deployment-specific network isolation checks pass. */
  verifyIsolation(sandbox: CreateOSSandbox): Promise<void>;
  /** Verify this attempt belongs to an already claimed, paid job (including retries). */
  authorizeExecution(snapshotId: string): Promise<boolean>;
  /** Trusted catalog lookup; must match DatasetDescriptor.tableName. */
  resolveTableName?(datasetId: string): string | Promise<string>;
  options?: SandboxExecutionOptions;
}

export class SandboxError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "SandboxError"; }
}

/** Shape/size checks only. This is NOT privacy approval; OutputPolicy must follow. */
export function parseExecutionResult(stdout: string): ExecutionResult {
  const invalid = () => new SandboxError("INVALID_SANDBOX_RESULT");
  if (Buffer.byteLength(stdout) > 1_000_000) throw invalid();
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["columns", "rows", "groupSizes"].includes(k))) throw invalid();
  if (!Array.isArray(v.columns) || v.columns.length > 100 ||
      v.columns.some(c => typeof c !== "string" || !c || c.length > 256 ||
        ["__proto__", "constructor", "prototype"].includes(c)) ||
      new Set(v.columns).size !== v.columns.length ||
      !Array.isArray(v.rows) || v.rows.length > 1000) throw invalid();
  const columns = v.columns as string[];
  for (const row of v.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).length !== columns.length ||
        columns.some(c => !Object.hasOwn(row, c))) throw invalid();
    for (const cell of Object.values(row)) {
      if (cell !== null && !(typeof cell === "string" && cell.length <= 10_000) &&
          !(typeof cell === "number" && Number.isFinite(cell))) throw invalid();
    }
  }
  if (v.groupSizes !== undefined && (!Array.isArray(v.groupSizes) ||
      v.groupSizes.length !== v.rows.length ||
      v.groupSizes.some(n => !Number.isSafeInteger(n) || n < 0))) throw invalid();
  return v as unknown as ExecutionResult;
}

export class CreateOSRuntime implements SandboxRuntime {
  private readonly snapshots = new Map<string, CreateOSSandbox>();
  private readonly active = new Set<string>();
  private readonly executionDone = new Map<string, Promise<void>>();
  private readonly destroying = new Map<string, Promise<void>>();
  private readonly pendingCleanup = new Map<string, Set<CreateOSSandbox>>();
  private readonly timeoutMs: number;
  constructor(private readonly config: RuntimeConfig) {
    const options = config.options ?? { timeoutMs: 30_000, maxRetries: 0 };
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 ||
        options.timeoutMs > 120_000 || options.maxRetries !== 0 ||
        !config.egress.length || config.egress.some(r => !r.trim())) {
      throw new SandboxError("INVALID_SANDBOX_CONFIG");
    }
    this.timeoutMs = options.timeoutMs;
  }

  private async remove(box: CreateOSSandbox): Promise<void> {
    await box.destroy();
    await box.waitUntilDestroyed();
  }

  async prepareDataset(datasetId: string, datasetPath: string): Promise<string> {
    const format = datasetPath.endsWith(".csv") ? "csv" : datasetPath.endsWith(".parquet") ? "parquet" : undefined;
    if (!datasetId || !format) throw new SandboxError("INVALID_DATASET");
    // datasetPath must come from the trusted dataset registry, never a buyer request.
    let box: CreateOSSandbox | undefined;
    try {
      const tableName = await this.config.resolveTableName?.(datasetId) ?? "dataset";
      if (!tableName || tableName.length > 256 || tableName.includes("\0")) {
        throw new SandboxError("INVALID_DATASET");
      }
      const [data, runner] = await Promise.all([
        readFile(datasetPath), readFile(new URL("../../sandbox/runner.py", import.meta.url), "utf8"),
      ]);
      if (data.byteLength > 50_000_000) throw new SandboxError("DATASET_TOO_LARGE");
      box = await this.config.client.createSandbox({ shape: this.config.shape,
        rootfs: this.config.rootfs, ingress_enabled: false, egress: [...this.config.egress] });
      this.snapshots.set(box.id, box);
      await this.config.verifyIsolation(box);
      await box.files.upload("/tmp/sealed-dataset", Uint8Array.from(data).buffer);
      await box.files.upload("/tmp/sealed-dataset.json", JSON.stringify({ tableName, format }));
      await box.files.upload("/tmp/sealed-runner.py", runner);
      await box.pause();
      await box.waitUntilPaused();
      return box.id;
    } catch {
      if (box) {
        try { await this.remove(box); this.snapshots.delete(box.id); }
        catch {
          this.pendingCleanup.set(box.id, new Set());
          throw new SandboxError("SANDBOX_CLEANUP_FAILED");
        }
      }
      throw new SandboxError("SANDBOX_PREPARATION_FAILED");
    }
  }

  async execute(snapshotId: string, code: string): Promise<ExecutionResult> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || this.active.has(snapshotId) || this.destroying.has(snapshotId) || this.pendingCleanup.has(snapshotId)) {
      throw new SandboxError("SNAPSHOT_UNAVAILABLE");
    }
    if (!code.trim() || Buffer.byteLength(code) > 64_000) throw new SandboxError("INVALID_CODE");
    this.active.add(snapshotId);
    let finished!: () => void;
    this.executionDone.set(snapshotId, new Promise(resolve => { finished = resolve; }));
    let child: CreateOSSandbox | undefined;
    try {
      if (!await this.config.authorizeExecution(snapshotId)) throw new SandboxError("PAYMENT_REQUIRED");
      child = await snapshot.fork({ ingress_enabled: false, egress: [...this.config.egress] });
      this.pendingCleanup.set(snapshotId, new Set([child]));
      // fork() can return while the clone is still in the `forking` state.
      await child.waitUntilRunning();
      await this.config.verifyIsolation(child);
      await child.files.upload("/tmp/sealed-analysis.py", code);
      // Keep timeout itself alive to report exit 137 instead of self-signaling.
      // VM destruction also kills any descendants left by foreground mode.
      const { result } = await child.runCommand("timeout", ["--foreground", "--signal=KILL",
        `${Math.ceil(this.timeoutMs / 1000)}s`, "python3", "-I", "/tmp/sealed-runner.py"],
      { timeoutMs: this.timeoutMs + 5000, retry: false });
      if ([124, 137].includes(result.exit_code)) throw new SandboxError("SANDBOX_TIMEOUT");
      if (result.exit_code !== 0 || result.error) throw new SandboxError("SANDBOX_EXECUTION_FAILED");
      return parseExecutionResult(result.stdout);
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError("SANDBOX_EXECUTION_FAILED");
    } finally {
      try {
        if (child) { await this.remove(child); this.pendingCleanup.delete(snapshotId); }
      } catch { throw new SandboxError("SANDBOX_CLEANUP_FAILED"); }
      finally {
        this.active.delete(snapshotId);
        this.executionDone.delete(snapshotId);
        finished();
      }
    }
  }

  async destroy(snapshotId: string): Promise<void> {
    const existing = this.destroying.get(snapshotId);
    if (existing) return existing;
    // The orchestrator may time out its promise before the remote command ends.
    // Wait for bounded execution/child cleanup rather than leak a busy snapshot.
    const cleanup = this.destroyAfterExecution(snapshotId);
    this.destroying.set(snapshotId, cleanup);
    try { await cleanup; }
    finally { this.destroying.delete(snapshotId); }
  }

  private async destroyAfterExecution(snapshotId: string): Promise<void> {
    await this.executionDone.get(snapshotId);
    let failed = false;
    const children = this.pendingCleanup.get(snapshotId);
    for (const child of children ?? []) {
      try { await this.remove(child); children?.delete(child); }
      catch { failed = true; }
    }
    if (!children?.size) this.pendingCleanup.delete(snapshotId);
    // A stuck child must not prevent deletion of its dataset snapshot.
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot) {
      try { await this.remove(snapshot); this.snapshots.delete(snapshotId); }
      catch { failed = true; }
    }
    if (failed) throw new SandboxError("SANDBOX_CLEANUP_FAILED");
  }

  /** Server-only shutdown/recovery helper, including failed preparations. */
  async dispose(): Promise<void> {
    let failed = false;
    for (const id of new Set([...this.snapshots.keys(), ...this.pendingCleanup.keys()])) {
      try { await this.destroy(id); } catch { failed = true; }
    }
    if (failed) throw new SandboxError("SANDBOX_CLEANUP_FAILED");
  }
}
